import os
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest.mock import patch

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

    def test_load_jsonc_keeps_comma_brace_in_strings(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "opencode.jsonc"
            config.write_text(
                textwrap.dedent(
                    """
                    {
                      "message": ", }",
                    }
                    """
                ),
                encoding="utf-8",
            )

            self.assertEqual(rsp.load_jsonc(config)["message"], ", }")

    def test_load_jsonc_expands_environment_variable_in_override_file_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with patch.dict(os.environ, {"RENDERER_TEST_DIR": str(root)}, clear=False):
                (root / "task.txt").write_text("task replacement", encoding="utf-8")
                config = root / "opencode.jsonc"
                config.write_text(
                    '''
                    {
                      "plugin": [["./prompt-overrides.ts", {
                        "tool": { "task": { "file": "{env:RENDERER_TEST_DIR}/task.txt" } }
                      }]]
                    }
                    ''',
                    encoding="utf-8",
                )

                result = rsp.apply_overrides(
                    rsp.RenderedPrompt(system="base", tools={"task": "task original"}),
                    rsp.load_jsonc(config),
                    root,
                    provider="test-provider",
                    model="configured-model",
                    api_id="api-model",
                    agent_has_prompt=False,
                    base_system="base",
                )

                self.assertEqual(result.tools["task"], "task replacement")

    def test_load_jsonc_reports_all_missing_environment_variables(self):
        with patch.dict(os.environ, {}, clear=True):
            with tempfile.TemporaryDirectory() as tmp:
                config = Path(tmp) / "opencode.jsonc"
                config.write_text(
                    '{ "first": "{env:RENDERER_MISSING_FIRST}", "second": "{env:RENDERER_MISSING_SECOND}" }',
                    encoding="utf-8",
                )

                with self.assertRaisesRegex(
                    ValueError,
                    "Missing environment variables: RENDERER_MISSING_FIRST, RENDERER_MISSING_SECOND",
                ):
                    rsp.load_jsonc(config)

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

    def test_empty_agent_prompt_allows_model_override(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "model.txt").write_text("model replacement", encoding="utf-8")
            config = {
                "agent": {"build": {"prompt": ""}},
                "plugin": [["./prompt-overrides.ts", {"model": [{"match": "*", "file": "model.txt"}]}]],
            }

            result = rsp.render(config, root, provider="test-provider", model="configured-model", agent="build", source="overrides")

            self.assertEqual(result.system.split("\n", 1)[0], "model replacement")

    def test_override_mode_ignores_unrelated_plugin_tuples(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "model.txt").write_text("model replacement", encoding="utf-8")
            config = {
                "plugin": [
                    ["./other-plugin.ts", {"tool": {"custom": "value"}}],
                    [
                        "./prompt-overrides.ts",
                        {"model": [{"match": "test-provider/api-*", "file": "model.txt"}]},
                    ],
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
            self.assertEqual(result.tools["read"], "read original")

    def test_override_mode_accepts_versioned_and_scoped_plugin_specs(self):
        plugin_specs = [
            "prompt-overrides@1.0.0",
            "@scope/prompt-overrides@1.0.0",
        ]

        for plugin_spec in plugin_specs:
            with self.subTest(plugin_spec=plugin_spec):
                config = {
                    "plugin": [[plugin_spec, {"model": [{"match": "*", "text": "model replacement"}]}]],
                }
                document = rsp.RenderedPrompt(system="base prompt\nenvironment", tools={})

                result = rsp.apply_overrides(
                    document,
                    config,
                    Path.cwd(),
                    provider="test-provider",
                    model="configured-model",
                    api_id="api-model",
                    agent_has_prompt=False,
                    base_system="base prompt",
                )

                self.assertEqual(result.system, "model replacement\nenvironment")

    def test_override_mode_ignores_backup_prompt_override_path_spec(self):
        config = {
            "plugin": [["./prompt-overrides.backup.ts", {"model": [{"match": "*", "text": "model replacement"}]}]],
        }
        document = rsp.RenderedPrompt(system="base prompt\nenvironment", tools={})

        result = rsp.apply_overrides(
            document,
            config,
            Path.cwd(),
            provider="test-provider",
            model="configured-model",
            api_id="api-model",
            agent_has_prompt=False,
            base_system="base prompt",
        )

        self.assertEqual(result.system, "base prompt\nenvironment")

    def test_override_mode_rejects_malformed_prompt_override_tuple_options(self):
        config = {
            "plugin": [["./prompt-overrides.ts", "oops"]],
        }
        document = rsp.RenderedPrompt(system="base prompt\nenvironment", tools={})

        with self.assertRaisesRegex(ValueError, "Malformed prompt-overrides plugin options"):
            rsp.apply_overrides(
                document,
                config,
                Path.cwd(),
                provider="test-provider",
                model="configured-model",
                api_id="api-model",
                agent_has_prompt=False,
                base_system="base prompt",
            )

    def test_override_mode_rejects_prompt_override_tuple_with_missing_options(self):
        config = {
            "plugin": [["./prompt-overrides.ts"]],
        }
        document = rsp.RenderedPrompt(system="base prompt\nenvironment", tools={})

        with self.assertRaisesRegex(ValueError, "Malformed prompt-overrides plugin tuple"):
            rsp.apply_overrides(
                document,
                config,
                Path.cwd(),
                provider="test-provider",
                model="configured-model",
                api_id="api-model",
                agent_has_prompt=False,
                base_system="base prompt",
            )

    def test_override_mode_rejects_prompt_override_tuple_with_extra_items(self):
        config = {
            "plugin": [["./prompt-overrides.ts", {}, "extra"]],
        }
        document = rsp.RenderedPrompt(system="base prompt\nenvironment", tools={})

        with self.assertRaisesRegex(ValueError, "Malformed prompt-overrides plugin tuple"):
            rsp.apply_overrides(
                document,
                config,
                Path.cwd(),
                provider="test-provider",
                model="configured-model",
                api_id="api-model",
                agent_has_prompt=False,
                base_system="base prompt",
            )

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
