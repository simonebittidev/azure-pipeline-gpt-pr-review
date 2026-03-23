Based on all the review comments and analysis, provide a final summary and recommendation:

Review Summary: {{review_comments}}
Total Issues Found: {{total_issues}}
LLM Calls Used: {{llm_calls_used}}/{{max_llm_calls}}

Provide a final recommendation in JSON format:
{
  "overall_assessment": "approve" | "approve_with_suggestions" | "request_changes",
  "summary": "Overall summary of the review",
  "key_issues": "List of the most important issues found",
  "recommendations": "Specific recommendations for the PR author",
  "confidence": number (0.0-1.0)
}
