import tempfile
import textwrap
import unittest
from pathlib import Path

import render_system_prompt as rsp


class RenderSystemPromptTest(unittest.TestCase):
    def test_load_jsonc_accepts_comments_and_trailing_commas(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "opencode.jsonc"
            config.write_text(
                textwrap.dedent(
                    """
                    {
                      // comment
                      "agent": {
                        "build": { "prompt": "agent prompt", },
                      },
                    }
                    """
                ),
                encoding="utf-8",
            )

            self.assertEqual(rsp.load_jsonc(config)["agent"]["build"]["prompt"], "agent prompt")

    def test_model_candidates_match_runtime_plugin_shape(self):
        self.assertEqual(
            rsp.model_candidates("test-provider", "configured-model", "api-model"),
            ["test-provider/configured-model", "test-provider/api-model", "api-model"],
        )

    def test_override_mode_replaces_model_and_tool_base(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "model.txt").write_text("model replacement", encoding="utf-8")
            (root / "read.txt").write_text("read replacement", encoding="utf-8")
            config = {
                "plugin": [
                    [
                        "./prompt-overrides.ts",
                        {
                            "model": [{"match": "test-provider/api-*", "file": "model.txt"}],
                            "tool": {"read": {"match": "test-provider/api-*", "file": "read.txt"}},
                        },
                    ]
                ]
            }
            document = rsp.RenderedPrompt(system="base prompt\nenvironment", tools={"read": "read original"})

            result = rsp.apply_overrides(
                document,
                config,
                root,
                provider="test-provider",
                model="configured-model",
                api_id="api-model",
                agent_has_prompt=False,
                base_system="base prompt",
            )

            self.assertEqual(result.system, "model replacement\nenvironment")
            self.assertEqual(result.tools["read"], "read replacement")

    def test_agent_prompt_blocks_model_override(self):
        config = {
            "plugin": [["./prompt-overrides.ts", {"model": [{"match": "*", "text": "model replacement"}]}]],
        }
        document = rsp.RenderedPrompt(system="agent prompt\nenvironment", tools={})

        result = rsp.apply_overrides(
            document,
            config,
            Path.cwd(),
            provider="test-provider",
            model="configured-model",
            api_id="api-model",
            agent_has_prompt=True,
            base_system="agent prompt",
        )

        self.assertEqual(result.system, "agent prompt\nenvironment")

    def test_local_skills_are_rendered_when_described(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            skill = root / ".opencode" / "skills" / "demo" / "SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text(
                textwrap.dedent(
                    """
                    ---
                    name: demo
                    description: Use when testing prompt rendering.
                    ---

                    # Demo
                    """
                ).strip(),
                encoding="utf-8",
            )

            rendered = rsp.local_skills({}, root)

            self.assertEqual(len(rendered), 1)
            self.assertIn("<name>demo</name>", rendered[0])
            self.assertIn("<description>Use when testing prompt rendering.</description>", rendered[0])


if __name__ == "__main__":
    unittest.main()
