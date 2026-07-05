#!/usr/bin/env python3
from __future__ import annotations

import argparse
import copy
import dataclasses
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
PROMPT_DIR = REPO_ROOT / "packages" / "opencode" / "src" / "session" / "prompt"
TOOL_DIR = REPO_ROOT / "packages" / "opencode" / "src" / "tool"

BUILTIN_TOOL_IDS = {
    "bash",
    "read",
    "glob",
    "grep",
    "edit",
    "write",
    "apply_patch",
    "task",
    "todowrite",
    "webfetch",
    "websearch",
    "skill",
    "question",
    "lsp",
    "plan_exit",
    "execute",
}

TOOL_FILES = {
    "read": "read.txt",
    "glob": "glob.txt",
    "grep": "grep.txt",
    "edit": "edit.txt",
    "write": "write.txt",
    "apply_patch": "apply_patch.txt",
    "task": "task.txt",
    "todowrite": "todowrite.txt",
    "webfetch": "webfetch.txt",
    "websearch": "websearch.txt",
    "skill": "skill.txt",
    "question": "question.txt",
    "lsp": "lsp.txt",
    "plan_exit": "plan-exit.txt",
    "bash": "shell/shell.txt",
}


@dataclasses.dataclass(frozen=True)
class RenderedPrompt:
    system: str
    tools: dict[str, str]


def strip_jsonc(text: str) -> str:
    result: list[str] = []
    in_string = False
    escape = False
    line_comment = False
    block_comment = False
    i = 0
    while i < len(text):
        char = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if line_comment:
            if char == "\n":
                line_comment = False
                result.append(char)
            i += 1
            continue
        if block_comment:
            if char == "*" and nxt == "/":
                block_comment = False
                i += 2
                continue
            if char == "\n":
                result.append(char)
            i += 1
            continue
        if in_string:
            result.append(char)
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            i += 1
            continue
        if char == '"':
            in_string = True
            result.append(char)
            i += 1
            continue
        if char == "/" and nxt == "/":
            line_comment = True
            i += 2
            continue
        if char == "/" and nxt == "*":
            block_comment = True
            i += 2
            continue
        result.append(char)
        i += 1
    return re.sub(r",\s*([}\]])", r"\1", "".join(result))


def load_jsonc(path: Path) -> dict[str, Any]:
    parsed = json.loads(strip_jsonc(path.read_text(encoding="utf-8")))
    if not isinstance(parsed, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return parsed


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def select_model_prompt(api_id: str) -> str:
    lower = api_id.lower()
    if "gpt-4" in lower or "o1" in lower or "o3" in lower:
        return read(PROMPT_DIR / "beast.txt")
    if "gpt" in lower:
        return read(PROMPT_DIR / ("codex.txt" if "codex" in lower else "gpt.txt"))
    if "gemini-" in lower:
        return read(PROMPT_DIR / "gemini.txt")
    if "claude" in lower:
        return read(PROMPT_DIR / "anthropic.txt")
    if "trinity" in lower:
        return read(PROMPT_DIR / "trinity.txt")
    if "kimi" in lower:
        return read(PROMPT_DIR / "kimi.txt")
    return read(PROMPT_DIR / "default.txt")


def api_model_id(config: dict[str, Any], provider: str, model: str) -> str:
    provider_config = config.get("provider", {}).get(provider, {})
    if not isinstance(provider_config, dict):
        return model
    model_config = provider_config.get("models", {}).get(model, {})
    if isinstance(model_config, dict) and isinstance(model_config.get("id"), str):
        return model_config["id"]
    return model


def agent_prompt(config: dict[str, Any], agent: str) -> str | None:
    agents = config.get("agent", {})
    if not isinstance(agents, dict):
        return None
    item = agents.get(agent, {})
    if isinstance(item, dict) and isinstance(item.get("prompt"), str):
        return item["prompt"]
    return None


def git_root() -> Path:
    try:
        output = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], stderr=subprocess.DEVNULL, text=True)
        return Path(output.strip())
    except Exception:
        return Path.cwd()


def environment(provider: str, api_id: str) -> str:
    root = git_root()
    today = datetime.datetime.now().strftime("%a %b %d %Y")
    is_git = "yes" if (root / ".git").exists() else "no"
    return "\n".join(
        [
            f"You are powered by the model named {api_id}. The exact model ID is {provider}/{api_id}",
            "Here is some useful information about the environment you are running in:",
            "<env>",
            f"  Working directory: {Path.cwd()}",
            f"  Workspace root folder: {root}",
            f"  Is directory a git repo: {is_git}",
            f"  Platform: {sys.platform}",
            f"  Today's date: {today}",
            "</env>",
        ]
    )


def local_instructions(config: dict[str, Any], config_dir: Path) -> list[str]:
    result: list[str] = []
    for name in ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"]:
        path = Path.cwd() / name
        if path.exists():
            result.append(f"Instructions from: {path}\n{read(path)}")
            break
    for item in config.get("instructions", []) if isinstance(config.get("instructions", []), list) else []:
        if not isinstance(item, str) or item.startswith("http://") or item.startswith("https://"):
            continue
        path = Path(item).expanduser()
        if not path.is_absolute():
            path = config_dir / path
        if path.exists() and path.is_file():
            result.append(f"Instructions from: {path}\n{read(path)}")
    return result


def references(config: dict[str, Any], config_dir: Path) -> list[str]:
    refs = config.get("references", config.get("reference", {}))
    if not isinstance(refs, dict):
        return []
    lines: list[str] = []
    for name, value in sorted(refs.items()):
        if isinstance(value, str):
            path_value = value
            description = None
        elif isinstance(value, dict):
            path_value = value.get("path")
            description = value.get("description")
        else:
            continue
        if not isinstance(path_value, str) or not isinstance(description, str):
            continue
        path = Path(path_value).expanduser()
        if not path.is_absolute():
            path = config_dir / path
        lines.extend([
            "  <reference>",
            f"    <name>{name}</name>",
            f"    <path>{path}</path>",
            f"    <description>{description}</description>",
            "  </reference>",
        ])
    if not lines:
        return []
    return [
        "\n".join(
            [
                "Project references provide additional directories that can be accessed when relevant.",
                "<available_references>",
                *lines,
                "</available_references>",
            ]
        )
    ]


def skill_paths(config: dict[str, Any], config_dir: Path) -> list[Path]:
    roots = [config_dir / ".opencode" / "skills", config_dir / ".opencode" / "skill"]
    skills = config.get("skills", {})
    if isinstance(skills, dict) and isinstance(skills.get("paths"), list):
        for item in skills["paths"]:
            if not isinstance(item, str):
                continue
            path = Path(item).expanduser()
            roots.append(path if path.is_absolute() else config_dir / path)
    matches: list[Path] = []
    for root in roots:
        if root.exists():
            matches.extend(root.glob("**/SKILL.md"))
    return sorted(set(matches))


def frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---\n"):
        return {}
    end = text.find("\n---", 4)
    if end == -1:
        return {}
    data: dict[str, str] = {}
    for line in text[4:end].splitlines():
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip('"').strip("'")
    return data


def local_skills(config: dict[str, Any], config_dir: Path) -> list[str]:
    entries: list[tuple[str, str, Path]] = []
    for path in skill_paths(config, config_dir):
        data = frontmatter(read(path))
        name = data.get("name") or path.parent.name
        description = data.get("description")
        if description:
            entries.append((name, description, path))
    if not entries:
        return []
    lines = [
        "Skills provide specialized instructions and workflows for specific tasks.",
        "Use the skill tool to load a skill when a task matches its description.",
        "<available_skills>",
    ]
    for name, description, path in sorted(entries):
        lines.extend(
            [
                "  <skill>",
                f"    <name>{name}</name>",
                f"    <description>{description}</description>",
                f"    <location>{path}</location>",
                "  </skill>",
            ]
        )
    lines.append("</available_skills>")
    return ["\n".join(lines)]


def render_bash_description(template: str) -> str:
    shell = Path(os.environ.get("SHELL", "bash")).name or "bash"
    values = {
        "intro": "Executes a given bash command in a persistent shell session with optional timeout, ensuring proper handling and security measures.",
        "os": sys.platform,
        "shell": shell,
        "tmp": tempfile.gettempdir(),
        "workdirSection": "All commands run in the current working directory by default. Use the `workdir` parameter if you need to run a command in a different directory. AVOID using `cd <directory> && <command>` patterns - use `workdir` instead.",
        "commandSection": "Usage notes:\n  - The command argument is required.\n  - You can specify an optional timeout in milliseconds. If not specified, commands will time out after 120000ms.",
        "gitCommands": "bash commands",
        "toolName": "bash",
        "gitCommandRestriction": "git bash commands",
        "createPrInstruction": "Create PR using gh pr create with a HEREDOC body.",
        "createPrExample": 'gh pr create --title "the pr title" --body "summary"',
    }
    for key, value in values.items():
        template = template.replace("${" + key + "}", value)
    return template


def tool_descriptions() -> dict[str, str]:
    tools: dict[str, str] = {}
    for tool_id, rel in TOOL_FILES.items():
        template = read(TOOL_DIR / rel)
        if tool_id == "bash":
            tools[tool_id] = render_bash_description(template)
        elif tool_id == "websearch":
            tools[tool_id] = template.replace("{{year}}", str(datetime.datetime.now().year))
        else:
            tools[tool_id] = template
    return tools


def model_candidates(provider: str, model: str, api_id: str) -> list[str]:
    return [f"{provider}/{model}", f"{provider}/{api_id}", api_id]


def match(pattern: str, candidates: list[str]) -> bool:
    if "*" not in pattern:
        return pattern in candidates
    regex = "^" + re.escape(pattern).replace("\\*", ".*") + "$"
    return any(re.match(regex, candidate) for candidate in candidates)


def source_content(source: dict[str, Any], config_dir: Path, label: str) -> tuple[str, str]:
    has_text = isinstance(source.get("text"), str)
    has_file = isinstance(source.get("file"), str)
    if has_text == has_file:
        raise ValueError(f"{label} must define exactly one of text or file")
    pattern = source.get("match", "*")
    if not isinstance(pattern, str):
        raise ValueError(f"{label}.match must be a string")
    if has_text:
        return pattern, source["text"]
    file_path = Path(source["file"]).expanduser()
    if not file_path.is_absolute():
        file_path = config_dir / file_path
    try:
        return pattern, read(file_path)
    except OSError as exc:
        raise ValueError(f"Failed to read prompt override file {file_path}") from exc


def override_options(config: dict[str, Any]) -> dict[str, Any] | None:
    for item in config.get("plugin", []) if isinstance(config.get("plugin", []), list) else []:
        if isinstance(item, list) and len(item) == 2 and isinstance(item[1], dict):
            if "model" in item[1] or "tool" in item[1]:
                return item[1]
    return None


def normalize_sources(value: Any) -> list[dict[str, Any]]:
    return value if isinstance(value, list) else [value]


def apply_overrides(
    document: RenderedPrompt,
    config: dict[str, Any],
    config_dir: Path,
    provider: str,
    model: str,
    api_id: str,
    agent_has_prompt: bool,
    base_system: str | None = None,
) -> RenderedPrompt:
    options = override_options(config)
    if options is None:
        return document
    candidates = model_candidates(provider, model, api_id)
    system = document.system
    tools = copy.deepcopy(document.tools)
    if not agent_has_prompt:
        for index, source in enumerate(normalize_sources(options.get("model", []))):
            if not isinstance(source, dict):
                raise ValueError(f"model[{index}] must be an object")
            pattern, content = source_content(source, config_dir, f"model[{index}]")
            if match(pattern, candidates):
                if base_system and system.startswith(base_system):
                    system = content + system[len(base_system) :]
                break
    tool_options = options.get("tool", {})
    if tool_options is not None and not isinstance(tool_options, dict):
        raise ValueError("tool must be an object keyed by built-in tool id")
    for tool_id, value in (tool_options or {}).items():
        if tool_id not in BUILTIN_TOOL_IDS:
            raise ValueError(f"Unknown built-in tool id: {tool_id}")
        for index, source in enumerate(normalize_sources(value)):
            if not isinstance(source, dict):
                raise ValueError(f"tool.{tool_id}[{index}] must be an object")
            pattern, content = source_content(source, config_dir, f"tool.{tool_id}[{index}]")
            if match(pattern, candidates):
                if tool_id in tools:
                    tools[tool_id] = content
                break
    return RenderedPrompt(system=system, tools=tools)


def render(config: dict[str, Any], config_dir: Path, provider: str, model: str, agent: str, source: str) -> RenderedPrompt:
    api_id = api_model_id(config, provider, model)
    prompt = agent_prompt(config, agent)
    base = prompt or select_model_prompt(api_id)
    sections = [
        base,
        environment(provider, api_id),
        *references(config, config_dir),
        *local_instructions(config, config_dir),
        *local_skills(config, config_dir),
    ]
    document = RenderedPrompt(system="\n".join(section for section in sections if section), tools=tool_descriptions())
    if source == "overrides":
        return apply_overrides(document, config, config_dir, provider, model, api_id, prompt is not None, base)
    return document


def main() -> int:
    parser = argparse.ArgumentParser(description="Render an OpenCode system prompt approximation.")
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--agent", default="build")
    parser.add_argument("--source", choices=["builtin", "overrides"], required=True)
    args = parser.parse_args()

    config = load_jsonc(args.config)
    document = render(config, args.config.resolve().parent, args.provider, args.model, args.agent, args.source)
    print("# System Message")
    print(document.system)
    print("\n# Tool Descriptions")
    for tool_id in sorted(document.tools):
        print(f"\n## {tool_id}")
        print(document.tools[tool_id])
    print(
        "Warning: standalone renderer does not execute plugins, connect MCP servers, fetch remote config/instructions/skills, or resolve auth-mutated provider catalogs.",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
