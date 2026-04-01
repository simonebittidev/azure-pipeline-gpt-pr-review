# Advanced Azure DevOps PR Reviewer

An intelligent, AI-powered Pull Request reviewer for Azure DevOps that uses Azure OpenAI to provide precise, contextual code reviews.

## 🚀 Features

### 🤖 Advanced AI-Powered Review
- **Advanced Reasoning Pipelines**: Uses structured multi-step prompts to analyze code systematically
- **Azure OpenAI Integration**: Leverages state-of-the-art language models for accurate code analysis
- **Context-Aware Review**: Understands PR context and only writes reviews when necessary
- **Maximum 100 LLM Calls**: Efficient resource usage with configurable limits

### 🔍 Comprehensive Code Analysis
- **Code Quality Review**: Identifies bugs, performance issues, and maintainability concerns
- **Security Scanning**: Detects vulnerabilities like SQL injection, XSS, hardcoded secrets
- **Style & Standards**: Ensures adherence to coding standards and best practices
- **Test Coverage**: Analyzes test adequacy and suggests improvements
- **Precise Diff Tracking**: Comments are anchored to the exact modified lines with automatic range selection, even when Azure DevOps omits diff hunks

### 🛠️ Azure DevOps Integration
- **Inline Comments**: Posts specific feedback directly on code lines
- **File-Level Comments**: Provides comprehensive file overviews
- **PR Summary**: Generates detailed review summaries with actionable recommendations
- **Smart Filtering**: Skips binary files and focuses on reviewable code

### 📊 Intelligent Decision Making
- **Context Analysis**: Determines if detailed review is needed based on PR scope
- **Confidence Scoring**: Only suggests changes above configurable confidence thresholds
- **Actionable Feedback**: Provides specific code suggestions and improvements
- **Review Recommendations**: Suggests approve, approve with suggestions, or request changes

## 🏗️ Architecture

The extension orchestrates a structured review pipeline:

```
PR Context → Context Analysis → File Review → Security Scan → Code Suggestions → Final Assessment
     ↓              ↓              ↓           ↓              ↓              ↓
  Determine      Review Each    Security    Generate      Post Results   Task Result
  Review Need    File          Analysis    Suggestions    to Azure      & Summary
```

### Core Components

1. **Review Orchestrator**: Coordinates the entire review process
2. **LLM Orchestrator**: Manages the reasoning flow and LLM interactions
3. **Azure DevOps Service**: Handles all Azure DevOps API interactions
4. **Review State Management**: Tracks review progress and maintains context

## 📋 Prerequisites

### Azure OpenAI Setup
1. **Azure OpenAI Resource**: Create an Azure OpenAI resource in your Azure subscription
2. **Model Deployment**: Deploy a GPT-5-codex or an older model
3. **API Access**: Ensure your Azure DevOps pipeline has access to the Azure OpenAI endpoint
4. **Preview Models**: For GPT‑4.1/GPT‑5 deployments, use the latest preview API version (e.g., `2024-08-01-preview`) and enable the Responses API input.

### Azure DevOps Configuration
1. **Build Service Permissions**: The build service needs permissions to:
   - Read repository content
   - Create and manage PR comments
   - Access PR details and changes
   - Contribute to pull requests (Project Settings → Repos → Repositories → Security → select *\<ProjectName> Build Service* → grant **Contribute to pull requests**)

2. **Pipeline Variables**: Configure the following variables:
   - `azure_openai_endpoint`: Your Azure OpenAI endpoint URL
   - `azure_openai_api_key`: Your Azure OpenAI API key
   - `azure_openai_deployment_name`: Your model deployment name

3. **Expose the OAuth Token to the Job**  
   The extension posts inline comments via the pipeline’s OAuth token. Make sure scripts can access it:

   - **YAML pipelines**
     ```yaml
     steps:
     - checkout: self
       persistCredentials: true
     ```
   - **Classic editor** – enable **Allow scripts to access the OAuth token** in the Agent job properties.

4. **Endpoint Format Reminder**  
   Azure endpoints follow  
   `https://{resource}.openai.azure.com/openai/deployments/{deployment}/responses?api-version={version}`.  
   Older GPT‑3.5/4 deployments that still require `/chat/completions` should keep using the legacy endpoint.

## 🚀 Installation

### 1. Install the Extension
- Download the extension from the Azure DevOps marketplace
- Install it in your Azure DevOps organization

### 2. Add to Pipeline
Add the task to your Azure DevOps pipeline YAML:

```yaml
- task: GENAIADVANCEDPRREVIEWER@2
  continueOnError: true
  inputs:
    azure_openai_endpoint: '$(azure_openai_endpoint)'
    azure_openai_api_key: '$(azure_openai_api_key)'
    azure_openai_deployment_name: '$(azure_openai_deployment_name)'
    azure_openai_api_version: '$(azure_openai_api_version)'
    azure_openai_use_responses_api: true
    max_llm_calls: '100'
    review_threshold: '0.7'
    enable_code_suggestions: true
    enable_security_scanning: true
    support_self_signed_certificate: false
```

### 3. Configure Variables
Set up pipeline variables in Azure DevOps:

```yaml
variables:
  azure_openai_endpoint: https://yourendpoint.openai.azure.com
  azure_openai_deployment_name: gpt-5-codex
  azure_openai_api_version: 2025-04-01-preview
  # store the key as a secret variable
  azure_openai_api_key: $(azure_openai_api_key)
```

## ⚙️ Configuration Options

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `azure_openai_endpoint` | string | ✅ | - | Azure OpenAI endpoint URL |
| `azure_openai_api_key` | string | ✅ | - | Azure OpenAI API key |
| `azure_openai_deployment_name` | string | ✅ | - | Model deployment name |
| `max_llm_calls` | string | ❌ | 100 | Maximum LLM calls allowed |
| `review_threshold` | string | ❌ | 0.7 | Confidence threshold for suggestions |
| `enable_code_suggestions` | boolean | ❌ | true | Enable AI code suggestions |
| `enable_security_scanning` | boolean | ❌ | true | Enable security vulnerability scanning |
| `support_self_signed_certificate` | boolean | ❌ | false | Support self-signed certificates |
| `azure_openai_api_version` | string | ❌ | 2025-04-01-preview | Azure OpenAI API version (preview required for GPT‑5 deployments) |
| `azure_openai_use_responses_api` | boolean | ❌ | false | Call the modern Responses API (required for GPT‑4.1 and GPT‑5 deployments) |
| `mcp_servers` | multi-line string | ❌ | - | JSON array describing MCP servers that enrich each review with additional context |
| `custom_instructions_path` | string | ❌ | `.pr-review` | Relative path from repo root to the folder containing custom `.md` prompt files |

## 📝 Custom Prompts & Templates

You can fully replace any of the LLM prompts and output templates by adding `.md` files inside a `.pr-review/` folder in your repository. Each file is version-controlled alongside your code and completely replaces the corresponding default.

### Folder structure

The `.pr-review/` folder is organised into three subfolders:

```
.pr-review/
├── prompts/       # Full prompt replacement — completely overrides the built-in prompt
│   ├── context-prompt.md
│   ├── review-prompt.md
│   ├── security-prompt.md
│   ├── suggestions-prompt.md
│   └── finalization-prompt.md
├── rules/         # Partial injection — merged into the prompt without replacing it
│   ├── context-rules.md
│   ├── review-rules.md
│   ├── security-rules.md
│   ├── suggestions-rules.md
│   └── finalization-rules.md
└── templates/     # Output templates — control how results are formatted
    └── summary-template.md
```

All files are optional and silently ignored if absent — the built-in default is always used as fallback.

### prompts/ — full replacement

Each file completely replaces the corresponding built-in prompt. Use this when you need full control over the structure, tone, and instructions sent to the model.

| File | Stage | Description |
|------|-------|-------------|
| `context-prompt.md` | Context analysis | Decides if a detailed review is needed |
| `review-prompt.md` | File review | Main code quality review — runs once per changed file |
| `security-prompt.md` | Security scan | Vulnerability scan — runs once per changed file when enabled |
| `suggestions-prompt.md` | Suggestions | Expands review comments into before/after code examples |
| `finalization-prompt.md` | Final assessment | Produces the overall PR approval recommendation |

The placeholder `{{custom_rules}}` is available in all prompt files and is resolved to the content of the matching `rules/` file (if present). If you omit the placeholder from your custom prompt, rules are appended automatically at the end.

### rules/ — partial injection

Each file injects additional instructions into the corresponding stage **without replacing the built-in prompt**. Use this when you only need to add project-specific business rules and don't want to maintain a full custom prompt.

| File | Injected into |
|------|--------------|
| `context-rules.md` | Context analysis |
| `review-rules.md` | File review |
| `security-rules.md` | Security scan |
| `suggestions-rules.md` | Suggestions |
| `finalization-rules.md` | Final assessment |

Rules are written in plain language — no JSON schema knowledge required. Example (`context-rules.md`):

```markdown
- CHANGELOG.md must be updated in every PR.
- Every new feature must include unit tests.
- Breaking changes must be documented in docs/breaking-changes.md.
```

Rules that require changes to a specific file are returned by the LLM as `file_suggestions` and posted as **file-level comments** directly on that file. The `file_path` is chosen dynamically — nothing is hardcoded.

### templates/ — output formatting

| File | Description |
|------|-------------|
| `summary-template.md` | Markdown layout of the PR summary comment posted to Azure DevOps |

### Placeholder variables

| Placeholder | Available in |
|-------------|-------------|
| `{{pr_title}}` | all files |
| `{{pr_description}}` | all files |
| `{{source_branch}}` | all files |
| `{{target_branch}}` | all files |
| `{{repository}}` | all files |
| `{{pr_id}}` | all files |
| `{{file_name}}` | `review-prompt.md`, `security-prompt.md` |
| `{{changed_lines}}` | `review-prompt.md`, `security-prompt.md` |
| `{{diff}}` | `review-prompt.md`, `security-prompt.md` |
| `{{line_context}}` | `review-prompt.md`, `security-prompt.md` |
| `{{expanded_context}}` | `review-prompt.md`, `security-prompt.md` |
| `{{external_context}}` | `review-prompt.md`, `security-prompt.md`, `context-prompt.md` |
| `{{custom_rules}}` | all `prompts/` files |
| `{{changed_files}}` | `context-prompt.md` |
| `{{review_comments}}` | `suggestions-prompt.md`, `finalization-prompt.md` |
| `{{total_issues}}` | `finalization-prompt.md` |
| `{{llm_calls_used}}` | `finalization-prompt.md` |
| `{{max_llm_calls}}` | `finalization-prompt.md` |
| `{{overall_assessment}}` | `summary-template.md` |
| `{{status}}` | `summary-template.md` |
| `{{total_files_reviewed}}` | `summary-template.md` |
| `{{total_issues_found}}` | `summary-template.md` |
| `{{critical_issues}}` | `summary-template.md` |
| `{{security_issues}}` | `summary-template.md` |
| `{{bug_issues}}` | `summary-template.md` |
| `{{improvement_issues}}` | `summary-template.md` |
| `{{style_issues}}` | `summary-template.md` |
| `{{test_issues}}` | `summary-template.md` |
| `{{summary}}` | `summary-template.md` |
| `{{recommendations}}` | `summary-template.md` |

### Quick start

Copy the ready-to-use examples from `.pr-review-example/` into your repo and edit them:

```bash
cp -r .pr-review-example/ path/to/your-repo/.pr-review/
```

The example files contain the current defaults as a starting point and preserve the `prompts/` / `templates/` subfolder structure.

### Using a custom folder path

```yaml
- task: GENAIADVANCEDPRREVIEWER@2
  inputs:
    azure_openai_endpoint: '$(azure_openai_endpoint)'
    azure_openai_api_key: '$(azure_openai_api_key)'
    azure_openai_deployment_name: 'gpt-4'
    custom_instructions_path: 'team-config/pr-review'  # default: .pr-review
```

## 🔌 MCP Server Integration

Model Context Protocol (MCP) servers let you plug repository-specific knowledge bases or business rules into the reviewer. Provide them as a JSON array via the `mcp_servers` input (typically using a multi-line string in YAML).

### YAML configuration example

```yaml
- task: GENAIADVANCEDPRREVIEWER@2
  inputs:
    azure_openai_endpoint: 'https://your-resource.openai.azure.com/'
    azure_openai_api_key: '$(AZURE_OPENAI_API_KEY)'
    azure_openai_deployment_name: 'gpt-5-codex'
    mcp_servers: |
      [
        {
          "name": "repository-knowledge",
          "endpoint": "https://example.com/mcp/context",
          "headers": {
            "Authorization": "Bearer $(MCP_TOKEN)"
          },
          "timeoutMs": 8000,
          "payloadTemplate": "{\"query\":\"best practices for {{file_path}}\",\"fileDiff\":\"{{file_diff}}\",\"pr\":\"{{pr_context}}\"}"
        }
      ]
```

### Supported fields
- `name` (required): Friendly identifier used in logs.
- `endpoint` (required): HTTP URL of the MCP server endpoint.
- `method`: HTTP method (`POST` by default).
- `headers`: Additional request headers (e.g., bearer tokens).
- `timeoutMs`: Request timeout in milliseconds (defaults to 10s).
- `payloadTemplate`: Optional JSON template string. The agent replaces placeholders like `{{file_path}}`, `{{file_diff}}`, `{{file_content}}`, `{{pr_context}}`, and `{{metadata}}` before sending the request. When omitted, a default payload containing the diff, file content, and PR metadata is used.

### Response expectations
- Plain strings are treated as context items.
- JSON arrays should contain strings or objects with a `text` property.
- JSON objects can return `context`, `contexts`, `content`, or `summary` fields (strings or string arrays).
- Non-parsable responses are captured as raw text, ensuring the reviewer still receives the additional context.

## 🔧 How It Works

### 1. Context Analysis
The agent first analyzes the PR context to determine if a detailed review is necessary:
- PR title and description
- Changed files and scope
- Branch information
- Author and reviewer details

### 2. File-by-File Review
For each changed file, the agent:
- Retrieves file content and diff
- Performs comprehensive code analysis
- Identifies issues and improvements
- Generates specific suggestions

### 3. Security Analysis
When enabled, performs security scanning for:
- SQL injection vulnerabilities
- XSS and injection attacks
- Hardcoded secrets
- Insecure authentication patterns
- Input validation issues

### 4. Code Suggestions
Generates actionable improvements:
- Before/after code examples
- Performance optimizations
- Readability improvements
- Best practice recommendations

### 5. Final Assessment
Provides comprehensive review summary:
- Overall quality assessment
- Issue categorization and counts
- Approval recommendations
- Actionable next steps

## 📊 Review Output

### Comment Types
- **🐛 Bug**: Logic errors and functional issues
- **🔒 Security**: Security vulnerabilities and concerns
- **💡 Improvement**: Code quality and maintainability suggestions
- **🎨 Style**: Coding standards and formatting issues
- **🧪 Test**: Test coverage and testing recommendations

### Review Summary
The extension posts a comprehensive summary comment including:
- Overall assessment (approve/approve with suggestions/request changes)
- Statistics on issues found by category
- Summary of key findings
- Specific recommendations for the PR author

## 🎯 Best Practices

### For Developers
1. **Clear PR Descriptions**: Provide context about what the PR accomplishes
2. **Focused Changes**: Keep PRs focused on single concerns
3. **Test Coverage**: Include tests for new functionality
4. **Code Standards**: Follow your team's coding standards

### For Pipeline Administrators
1. **Resource Management**: Set appropriate `max_llm_calls` based on your needs
2. **Threshold Tuning**: Adjust `review_threshold` based on team preferences
3. **Security Scanning**: Enable security scanning for production code
4. **Monitoring**: Monitor LLM usage and costs
5. **OAuth Token Access**: Confirm `persistCredentials: true` (or the classic “Allow scripts to access the OAuth token” toggle) so the reviewer can post PR comments.

### For Teams
1. **Review Culture**: Use the extension as a learning tool, not just a gate
2. **Feedback Integration**: Incorporate AI suggestions into team coding standards
3. **Continuous Improvement**: Regularly review and adjust configuration
4. **Knowledge Sharing**: Use AI insights to improve team coding practices

## 🔍 Troubleshooting

### Common Issues

#### Authentication Errors
- Verify Azure OpenAI API key is correct
- Ensure the key has access to the specified deployment
- Check if the key has expired

#### Permission Errors
- Verify build service has repository read access
- Ensure build service can create PR comments
- Check organization-level permissions

#### High LLM Usage
- Reduce `max_llm_calls` if hitting limits
- Adjust `review_threshold` to filter out low-confidence suggestions

#### Comments Not Highlighting Diff Lines
- Ensure the PR branch contains actual line modifications (not whitespace-only changes)
- Check pipeline logs for `🔧 Built fallback unified diff` messages—these confirm the reviewer successfully reconstructed diff hunks
- Verify the Azure DevOps build service has permission to call the PR diff APIs (`pullRequests/{id}/changes`, `diffs/commits`)

#### Azure OpenAI 400 Bad Request
- GPT-4.1/GPT-5 deployments require newer API versions (e.g., `2024-08-01-preview`) — set the `azure_openai_api_version` input accordingly
- Enable the `azure_openai_use_responses_api` flag for models that only support the Responses API
- Review the task logs for the exact error body — it will be surfaced when the request fails
- Consider disabling code suggestions for large PRs

#### Performance Issues
- Monitor Azure OpenAI service performance
- Check network connectivity to Azure OpenAI
- Consider using smaller models for faster responses

### Debug Information
The extension provides detailed logging:
- Configuration validation
- File processing progress
- LLM call tracking
- Error details and stack traces

### Verbose logging
You can enable verbose debug logs (shows LLM prompts and response previews) by setting the environment variable `ADVPR_VERBOSE=1`. The task manifest sets this by default for the packaged task, but you can override it in your pipeline or agent environment if you prefer quieter logs.

## 📈 Performance & Cost

### LLM Call Optimization
- **Context Analysis**: 1-2 calls per PR
- **File Review**: 3-5 calls per file (depending on complexity)
- **Security Scan**: 1-2 calls per file
- **Code Suggestions**: 1-2 calls per file with issues
- **Final Assessment**: 1 call per PR

### Cost Considerations
- Monitor Azure OpenAI usage and costs
- Adjust `max_llm_calls` based on budget constraints
- Use appropriate model tiers for your needs
- Consider batch processing for large repositories

## 🔮 Future Enhancements

### Planned Features
- **Integration with SonarQube**: Combined static and AI analysis
- **Multi-Language Support**: Enhanced support for various programming languages
- **Review History**: Track review quality and improvement over time
- **Team Learning**: Share insights across team members

### Extensibility
- **Plugin Architecture**: Support for custom review modules
- **API Integration**: Webhook support for external tools
- **Custom Models**: Support for fine-tuned models
- **Review Workflows**: Configurable review processes

## 🤝 Contributing

We welcome contributions! Please see our [Contributing Guide](CONTRIBUTING.md) for details.

### Development Setup
1. Clone the repository
2. Install dependencies: `npm install`
3. Build the project: `npm run build`
4. Run tests: `npm test`

### Code Standards
- Follow TypeScript best practices
- Include comprehensive error handling
- Add unit tests for new features
- Update documentation for changes

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- **Azure OpenAI Team**: For providing the underlying AI capabilities
- **Open Source Community**: For inspiration and feedback on advanced review workflows
- **Azure DevOps Team**: For the robust platform and APIs
- **Open Source Contributors**: For the various libraries and tools used

## 📞 Support

- **Issues**: Report bugs and feature requests on GitHub
- **Documentation**: Check this README and inline code comments
- **Community**: Join our discussions and share experiences
- **Enterprise**: Contact us for enterprise support and customization

---

**Made with ❤️ for the Azure DevOps community**
