"""Behavior tests for the documentation checker; these are not product tests."""

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.check_docs import check_repository


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_docs.py"


class DocumentationChecks(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write(self, relative, content="Document\n"):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def test_valid_inline_reference_image_and_encoded_destinations(self):
        self.write("docs/design (v1).md")
        self.write("docs/other.md")
        self.write("assets/icon.svg", "<svg/>")
        self.write("README.md", """# Home
[design](<docs/design (v1).md>)
[encoded](docs/design%20%28v1%29.md#heading)
[nested](docs/design%20(v1).md "Design")
[escaped](docs/design%20\\(v1\\).md)
[root](/docs/other.md?view=plain#title)
![image](assets/icon.svg)
[complete][guide]
[guide][]
[guide]
[external](https://example.com/not-checked)
[email](mailto:someone@example.com)
[anchor](#not-checked)
[guide]: docs/other.md "Guide"
""")
        self.assertEqual(check_repository(self.root).errors, [])

    def test_broken_relative_link_has_source_location(self):
        self.write("docs/start.md", "# Start\n[missing](missing.md)\n")
        result = check_repository(self.root)
        self.assertEqual(len(result.errors), 1)
        self.assertIn("docs/start.md:2", result.errors[0])
        self.assertIn("missing local destination: missing.md", result.errors[0])

    def test_broken_reference_definition_is_reported_once(self):
        self.write("README.md", "[a][guide]\n[b][guide]\n[guide]: absent.md\n")
        errors = check_repository(self.root).errors
        self.assertEqual(len(errors), 1)
        self.assertIn("README.md:3", errors[0])

    def test_undefined_explicit_reference_is_reported(self):
        self.write("README.md", "[a][undefined]\n")
        self.assertIn("undefined Markdown reference", check_repository(self.root).errors[0])

    def test_duplicate_declarations_fail_but_references_do_not(self):
        self.write("stories/first.md", "Story ID: S0-001\n")
        self.write("README.md", "S0-001 is referenced twice: S0-001.\n[first](stories/first.md)\n")
        self.assertEqual(check_repository(self.root).errors, [])
        self.write("stories/second.md", "Story ID: S0-001\n")
        errors = check_repository(self.root).errors
        self.assertEqual(len(errors), 1)
        self.assertIn("duplicate story ID S0-001", errors[0])

    def test_duplicate_declarations_in_same_file_fail(self):
        self.write("story.md", "Story ID: S0-001\nStory ID: S0-001\n")
        self.assertIn("duplicate story ID", check_repository(self.root).errors[0])

    def test_code_and_comment_examples_are_not_live_references(self):
        self.write("README.md", """Story ID: S0-001
````markdown
Story ID: S0-001
```python
[sample](missing.md)
```
````
~~~markdown
[sample](also-missing.md)
~~~
`[inline](missing.md)`
<!-- [comment](missing.md)
Story ID: S0-001 -->
""")
        self.assertEqual(check_repository(self.root).errors, [])

    def test_generated_directories_are_excluded_but_skills_are_checked(self):
        self.write("README.md")
        self.write("node_modules/README.md", "[bad](missing.md)")
        self.write(".git/README.md", "[bad](missing.md)")
        self.write(".agents/skills/example/SKILL.md", "[bad](missing.md)")
        result = check_repository(self.root)
        self.assertEqual(result.files_checked, 2)
        self.assertEqual(len(result.errors), 1)
        self.assertIn(".agents/skills/example/SKILL.md", result.errors[0])

    def test_relative_parent_links_are_resolved_from_document(self):
        self.write("README.md")
        self.write("docs/guide.md", "[home](../README.md)\n")
        self.assertEqual(check_repository(self.root).errors, [])

    def test_links_outside_repository_fail(self):
        self.write("README.md", "[outside](../outside.md)")
        self.assertIn("leaves repository", check_repository(self.root).errors[0])

    def test_empty_repository_does_not_claim_success(self):
        result = check_repository(self.root)
        self.assertEqual(result.files_checked, 0)
        self.assertTrue(result.errors)

    def test_cli_exit_status_matches_validation_result(self):
        document = self.write("README.md", "[bad](missing.md)")
        command = [sys.executable, str(SCRIPT), "--root", str(self.root)]
        failed = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(failed.returncode, 1)
        self.assertIn("FAIL:", failed.stdout)
        document.write_text("# Valid\n", encoding="utf-8")
        passed = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(passed.returncode, 0)
        self.assertIn("PASS:", passed.stdout)


if __name__ == "__main__":
    unittest.main()
