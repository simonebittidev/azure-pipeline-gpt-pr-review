import * as tl from "azure-pipelines-task-lib/task";
import { ReviewOrchestrator } from './services/review-orchestrator';
import https from 'https';
import { MCPServerConfig } from './types/mcp';

async function run() {
  try {
    console.log("🚀 Advanced Azure DevOps PR Reviewer Starting...");
    
    // Validate PR context
    if (tl.getVariable('Build.Reason') !== 'PullRequest') {
      tl.setResult(tl.TaskResult.Skipped, "This task should be run only when the build is triggered from a Pull Request.");
      return;
    }

    // Get configuration from task inputs
    const azureOpenAIEndpoint = tl.getInput('azure_openai_endpoint', true);
    const azureOpenAIKey = tl.getInput('azure_openai_api_key', true);
    const deploymentName = tl.getInput('azure_openai_deployment_name', true);
    const maxLLMCalls = parseInt(tl.getInput('max_llm_calls') || '100');
    const reviewThreshold = parseFloat(tl.getInput('review_threshold') || '0.7');
    const enableCodeSuggestions = tl.getBoolInput('enable_code_suggestions');
    const enableSecurityScanning = tl.getBoolInput('enable_security_scanning');
    const supportSelfSignedCertificate = tl.getBoolInput('support_self_signed_certificate');
    const azureOpenAIApiVersion = tl.getInput('azure_openai_api_version') || '2024-02-15-preview';
    const useResponsesApi = tl.getBoolInput('azure_openai_use_responses_api');
    const mcpServersRaw = tl.getInput('mcp_servers');
    const customInstructionsFolder = tl.getInput('custom_instructions_path') || '.pr-review';

    let mcpServers: MCPServerConfig[] = [];
    if (mcpServersRaw) {
      try {
        const parsed = JSON.parse(mcpServersRaw);
        if (!Array.isArray(parsed)) {
          throw new Error('Configuration must be a JSON array');
        }
        mcpServers = parsed as MCPServerConfig[];
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        tl.setResult(tl.TaskResult.Failed, `Invalid MCP servers configuration: ${message}`);
        return;
      }
    }

    // Validate required inputs
    if (!azureOpenAIEndpoint) {
      tl.setResult(tl.TaskResult.Failed, 'Azure OpenAI endpoint is required!');
      return;
    }

    if (!azureOpenAIKey) {
      tl.setResult(tl.TaskResult.Failed, 'Azure OpenAI API key is required!');
      return;
    }

    if (!deploymentName) {
      tl.setResult(tl.TaskResult.Failed, 'Azure OpenAI deployment name is required!');
      return;
    }

    // Validate configuration values
    if (maxLLMCalls < 1 || maxLLMCalls > 1000) {
      tl.setResult(tl.TaskResult.Failed, 'Maximum LLM calls must be between 1 and 1000!');
      return;
    }

    if (reviewThreshold < 0.0 || reviewThreshold > 1.0) {
      tl.setResult(tl.TaskResult.Failed, 'Review threshold must be between 0.0 and 1.0!');
      return;
    }

    // Create HTTPS agent for self-signed certificate support
    const httpsAgent = new https.Agent({
      rejectUnauthorized: !supportSelfSignedCertificate
    });

    console.log("📋 Configuration:");
    console.log(`  - Azure OpenAI Endpoint: ${azureOpenAIEndpoint}`);
    console.log(`  - Deployment Name: ${deploymentName}`);
    console.log(`  - Max LLM Calls: ${maxLLMCalls}`);
    console.log(`  - Review Threshold: ${reviewThreshold}`);
    console.log(`  - Code Suggestions: ${enableCodeSuggestions ? 'Enabled' : 'Disabled'}`);
    console.log(`  - Security Scanning: ${enableSecurityScanning ? 'Enabled' : 'Disabled'}`);
    console.log(`  - OpenAI API Version: ${azureOpenAIApiVersion}`);
    console.log(`  - Use Responses API: ${useResponsesApi ? 'Yes' : 'No'}`);
    console.log(`  - MCP Servers: ${mcpServers.length}`);
    console.log(`  - Custom Instructions Folder: ${customInstructionsFolder}`);
    console.log(`  - Self-signed Certificates: ${supportSelfSignedCertificate ? 'Supported' : 'Not Supported'}`);

    // Create and run the review orchestrator
    const orchestrator = new ReviewOrchestrator(
      httpsAgent,
      azureOpenAIEndpoint,
      azureOpenAIKey,
      deploymentName,
      maxLLMCalls,
      reviewThreshold,
      enableCodeSuggestions,
      enableSecurityScanning,
      azureOpenAIApiVersion,
      useResponsesApi,
      mcpServers,
      customInstructionsFolder
    );

    console.log("🔍 Starting comprehensive PR review...");
    
    const reviewResult = await orchestrator.runFullReview();

    // Log review results
    console.log("📊 Review Completed Successfully!");
    console.log(`  - Files Reviewed: ${reviewResult.totalFilesReviewed}`);
    console.log(`  - Total Comments: ${reviewResult.totalComments}`);
    console.log(`  - LLM Calls Used: ${reviewResult.llmCallsUsed}/${reviewResult.maxLLMCalls}`);
    console.log(`  - Requires Changes: ${reviewResult.requiresChanges ? 'Yes' : 'No'}`);
    console.log(`  - Can Approve: ${reviewResult.canApprove ? 'Yes' : 'No'}`);
    console.log(`  - Summary: ${reviewResult.reviewSummary}`);

    // Set task result based on review outcome
    if (reviewResult.requiresChanges) {
      tl.setResult(tl.TaskResult.Succeeded, `PR Review completed. ${reviewResult.totalComments} issues found requiring changes.`);
    } else if (reviewResult.totalComments > 0) {
      tl.setResult(tl.TaskResult.Succeeded, `PR Review completed. ${reviewResult.totalComments} improvement suggestions found. PR can be approved with suggestions.`);
    } else {
      tl.setResult(tl.TaskResult.Succeeded, "PR Review completed. No issues found. PR is ready for approval.");
    }

  } catch (error: any) {
    console.error("❌ Fatal error during PR review:", error);
    
    // Provide detailed error information
    if (error.response) {
      console.error(`  - Status: ${error.response.status}`);
      console.error(`  - Data: ${JSON.stringify(error.response.data)}`);
    }
    
    tl.setResult(tl.TaskResult.Failed, `PR Review failed: ${error.message}`);
  }
}

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  tl.setResult(tl.TaskResult.Failed, `Unhandled promise rejection: ${reason}`);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  tl.setResult(tl.TaskResult.Failed, `Uncaught exception: ${error.message}`);
});

run();
