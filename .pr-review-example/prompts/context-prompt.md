You are an expert code reviewer. Analyze the following PR context and determine if a detailed review is needed.

PR Title: {{pr_title}}
PR Description: {{pr_description}}
Changed Files: {{changed_files}}
{{external_context}}

Determine if this PR requires a detailed code review based on:
1. Complexity of changes
2. Risk level
3. Impact on the codebase
4. Quality of the PR description

{{custom_rules}}

Respond with JSON:
{
  "requires_review": boolean,
  "reasoning": string,
  "priority": "low" | "medium" | "high",
  "file_suggestions": [
    {
      "file_path": "path/to/file",
      "type": "bug" | "improvement" | "security" | "style" | "test",
      "description": "What needs to be done in this file and why",
      "suggestion": "Specific action to take",
      "confidence": 0.9
    }
  ]
}

Use file_suggestions only when a rule violation targets a specific file that needs to be created or updated.
Leave file_suggestions as an empty array if no file-specific action is required.
