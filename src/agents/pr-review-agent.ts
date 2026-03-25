import { z } from "zod";
import * as tl from "azure-pipelines-task-lib/task";
import fetch from 'node-fetch';
import {
  CustomInstructions,
  resolveReviewPrompt,
  resolveContextPrompt,
  resolveSuggestionsPrompt,
  resolveFinalizationPrompt,
} from '../services/custom-instructions-loader';

// Define the state schema for the PR review agent
export const PRReviewState = z.object({
  messages: z.array(z.any()),
  current_file: z.string().optional(),
  file_content: z.string().optional(),
  file_diff: z.string().optional(),
  review_comments: z.array(z.object({
    file: z.string(),
    line: z.number().optional(),
    comment: z.string(),
    type: z.enum(["bug", "improvement", "security", "style", "test"]),
    confidence: z.number(),
    suggestion: z.string().optional(),
    is_new_issue: z.boolean().optional(),
    is_fixed: z.boolean().optional()
  })).default([]),
  llm_calls: z.number().default(0),
  max_llm_calls: z.number(),
  review_threshold: z.number(),
  enable_code_suggestions: z.boolean(),
  enable_security_scanning: z.boolean(),
  pr_context: z.object({
    title: z.string(),
    description: z.string(),
    author: z.string(),
    target_branch: z.string(),
    source_branch: z.string(),
    changed_files: z.array(z.string())
  }).optional(),
  final_assessment: z.object({
    overall_assessment: z.string(),
    summary: z.string(),
    key_issues: z.string(),
    recommendations: z.string(),
    confidence: z.number()
  }).optional(),
  external_context: z.array(z.string()).default([])
});

export type PRReviewStateType = z.infer<typeof PRReviewState>;

type DiffPromptOptions = {
  roleIntroduction: string;
  fileName?: string | null;
  changedLineSummary: string;
  fileDiff: string;
  changedLinesContext?: string;
  expandedContext?: string;
  externalContextSection?: string;
  instructionsSection: string;
  jsonResponseReminder: string;
  responseSchema: string;
  criticalRequirements: string;
};

// Define the review analysis schema
const ReviewAnalysisSchema = z.object({
  has_issues: z.boolean(),
  issues: z.array(z.object({
    type: z.enum(["bug", "improvement", "security", "style", "test"]),
    severity: z.enum(["low", "medium", "high", "critical"]),
    description: z.string(),
    line_number: z.number().optional(),
    suggestion: z.string().optional(),
    confidence: z.number()
  })),
  overall_quality: z.enum(["excellent", "good", "acceptable", "needs_improvement", "poor"]),
  summary: z.string(),
  should_approve: z.boolean(),
  requires_changes: z.boolean()
});

export class AdvancedPRReviewAgent {
  private azureOpenAIEndpoint: string;
  private azureOpenAIKey: string;
  private deploymentName: string;
  private maxLLMCalls: number;
  private reviewThreshold: number;
  private llmCalls: number = 0;
  private verbose: boolean = true;
  private apiVersion: string;
  private useResponsesApi: boolean;
  private currentCustomInstructions: CustomInstructions = {};
  private currentPRContext: { repository: string; prId: string | number; prTitle: string; prDescription: string; sourceBranch: string; targetBranch: string } = { repository: '', prId: '', prTitle: '', prDescription: '', sourceBranch: '', targetBranch: '' };

  constructor(
    azureOpenAIEndpoint: string,
    azureOpenAIKey: string,
    deploymentName: string,
    maxLLMCalls: number = 100,
    reviewThreshold: number = 0.7,
    apiVersion: string = '2024-02-15-preview',
    useResponsesApi: boolean = false
  ) {
    this.azureOpenAIEndpoint = azureOpenAIEndpoint;
    this.azureOpenAIKey = azureOpenAIKey;
    this.deploymentName = deploymentName;
    this.maxLLMCalls = maxLLMCalls;
    this.reviewThreshold = reviewThreshold;
    this.apiVersion = apiVersion;
    this.useResponsesApi = useResponsesApi;
    // Verbose logging: default enabled unless explicitly disabled by ADVPR_VERBOSE=0
    try {
      const envVal = tl.getVariable('ADVPR_VERBOSE');
      this.verbose = !(envVal === '0' || process.env['ADVPR_VERBOSE'] === '0');
    } catch (e) {
      this.verbose = true;
    }
  }

  public async runReview(
    fileContent: string,
    fileDiff: string,
    fileName: string,
    prContext: any,
    lineMapping?: Map<number, { originalLine: number; modifiedLine: number; isAdded: boolean; isRemoved: boolean; isContext?: boolean }>,
    externalContext: string[] = [],
    customInstructions?: CustomInstructions
  ): Promise<PRReviewStateType> {
    this.currentCustomInstructions = customInstructions || {};
    this.currentPRContext = {
      repository:    prContext?.repository || '',
      prId:          prContext?.pr_id || '',
      prTitle:       prContext?.title || '',
      prDescription: prContext?.description || '',
      sourceBranch:  prContext?.source_branch || '',
      targetBranch:  prContext?.target_branch || '',
    };
    const initialState: PRReviewStateType = {
      messages: [],
      current_file: fileName,
      file_content: fileContent,
      file_diff: fileDiff,
      review_comments: [],
      llm_calls: 0,
      max_llm_calls: this.maxLLMCalls,
      review_threshold: this.reviewThreshold,
      enable_code_suggestions: true,
      enable_security_scanning: true,
      pr_context: prContext,
      external_context: externalContext || []
    };

    try {
      // Run the review process sequentially
      let state = await this.analyzeContext(initialState);
      state = await this.reviewFile(state, lineMapping);
      state = await this.securityScan(state);
      state = await this.generateSuggestions(state);
      state = await this.finalizeReview(state);

      return state;
    } catch (error) {
      console.error("Error running review:", error);
      return initialState;
    }
  }

  private async callAzureOpenAI(prompt: string): Promise<string> {
    if (this.llmCalls >= this.maxLLMCalls) {
      throw new Error("Maximum LLM calls reached");
    }

    if (this.verbose) {
      console.log('🧠 Sending prompt to Azure OpenAI:');
      console.log('────────────────────────────────────────────────────────');
      console.log(prompt);
      console.log('────────────────────────────────────────────────────────');
    }

    const preferResponsesApi = this.useResponsesApi;

    if (!preferResponsesApi) {
      console.warn(
        'Responses API is disabled. Enable the "Use Responses API" input or configure a deployment that supports chat completions.'
      );
    }

    try {
      return await this.performAzureOpenAIRequest(prompt, 'responsesDeployment', 'primary');
    } catch (error) {
      if (this.shouldTryGlobalResponsesEndpoint(error)) {
        const status = (error as { status?: number })?.status;
        const message = (error as Error)?.message || '';
        console.warn(
          `⚠️ Responses deployment endpoint returned 404${status ? ` (${status})` : ''}. Retrying via the global responses endpoint.`
        );
        if (this.verbose && message) {
          console.warn(`   ↳ Original error: ${message}`);
        }

        try {
          return await this.tryGlobalResponsesEndpoint(prompt);
        } catch (globalError) {
          const fallbackStatus = (globalError as { status?: number })?.status;
          const fallbackMessage =
            (globalError as { body?: string; message?: string })?.body ??
            (globalError as Error)?.message ??
            String(globalError);
          const guidance = [
            `Global Responses API request failed${fallbackStatus ? ` (status ${fallbackStatus})` : ''} for deployment "${this.deploymentName}".`,
            'Verify that the deployment is configured for the Responses API and that the specified `azure_openai_api_version` is supported.',
            'If the deployment cannot be reached via the global endpoint, ensure the resource name, deployment name, and permissions are correct.'
          ].join(' ');
          throw new Error(`${guidance}\nOriginal error: ${fallbackMessage}`);
        }
      }

      const status = (error as { status?: number })?.status;
      const message =
        (error as { body?: string; message?: string })?.body ?? (error as Error)?.message ?? String(error);
      const guidance = [
        `Responses API call failed${status ? ` (status ${status})` : ''} for deployment "${this.deploymentName}".`,
        'Confirm that the deployment exposes the Responses API endpoint and that the configured `azure_openai_api_version` is valid.'
      ].join(' ');
      throw new Error(`${guidance}\nOriginal error: ${message}`);
    }
  }

  private async performAzureOpenAIRequest(
    prompt: string,
    mode: 'responsesDeployment' | 'responsesGlobal' | 'chatCompletions',
    attempt: 'primary' | 'fallback',
    apiVersionOverride?: string
  ): Promise<string> {
    const isResponsesMode = mode !== 'chatCompletions';
    const deploymentBaseUrl = `${this.azureOpenAIEndpoint}/openai/deployments/${this.deploymentName}`;
    const apiVersion = apiVersionOverride ?? this.apiVersion;

    let url: string;
    const shouldAppendVersion = !isResponsesMode && apiVersion;

    switch (mode) {
      case 'responsesDeployment':
        url = `${deploymentBaseUrl}/responses`;
        break;
      case 'responsesGlobal':
        url = `${this.azureOpenAIEndpoint}/openai/v1/responses`;
        break;
      case 'chatCompletions':
      default:
        url = shouldAppendVersion
          ? `${deploymentBaseUrl}/chat/completions?api-version=${apiVersion}`
          : `${deploymentBaseUrl}/chat/completions`;
        break;
    }

    type ResponsesPayload = {
      model: string;
      input: Array<{ role: string; content: Array<{ type: 'input_text'; text: string }> }>;
      temperature: number;
      max_output_tokens: number;
      text?: { format: { type: string } };
    };

    type ChatPayload = {
      messages: Array<{ role: string; content: string }>;
      temperature: number;
      response_format: { type: string };
      max_tokens?: number;
      max_completion_tokens?: number;
    };

    const temperature = this.shouldForceDefaultTemperature(isResponsesMode) ? 1 : 0.1;

    const payload: ResponsesPayload | ChatPayload = isResponsesMode
      ? (() => {
          const responsesPayload: ResponsesPayload = {
            model: this.deploymentName,
            input: [
              {
                role: "system",
                content: [
                  {
                    type: "input_text",
                    text: "You are an expert code reviewer. You MUST respond with valid JSON only. Do not include any text before or after the JSON. Do not use markdown formatting. Return only the JSON object as requested."
                  }
                ]
              },
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: prompt
                  }
                ]
              }
            ],
            temperature,
            max_output_tokens: 4000
          };

          return responsesPayload;
        })()
      : (() => {
          const chatPayload: ChatPayload = {
            messages: [
              {
                role: "system",
                content: "You are an expert code reviewer. You MUST respond with valid JSON only. Do not include any text before or after the JSON. Do not use markdown formatting. Return only the JSON object as requested."
              },
              {
                role: "user",
                content: prompt
              }
            ],
            temperature,
            response_format: { type: "json_object" }
          };

          if (this.shouldUseMaxCompletionTokens(isResponsesMode)) {
            chatPayload.max_completion_tokens = 4000;
          } else {
            chatPayload.max_tokens = 4000;
          }

          return chatPayload;
        })();

    // Safe debug logging (do not print secrets)
    try {
      if (this.verbose) {
        const userMsg = 'input' in payload
          ? (payload.input.find((m) => m.role === 'user')?.content?.[0]?.text || '')
          : (payload.messages.find((m) => m.role === 'user')?.content || '');
        console.log('🔎 OpenAI request summary:');
        console.log(`  - URL: ${url}`);
        console.log(`  - Deployment: ${this.deploymentName}`);
        console.log(`  - Endpoint Mode: ${mode}${attempt === 'fallback' ? ' (fallback)' : ''}`);
        console.log(`  - API Version: ${shouldAppendVersion ? apiVersion : 'default'}`);
        const messageCount = 'input' in payload ? payload.input.length : payload.messages.length;
        console.log(`  - Messages: ${messageCount}`);
        console.log(`  - Prompt length: ${userMsg.length} chars`);
        console.log(`  - Prompt preview (first 600 chars):\n${userMsg.substring(0, 600)}`);
        if (userMsg.length > 600) console.log(`  - Prompt tail preview (last 200 chars):\n${userMsg.substring(userMsg.length - 200)}`);
      }
    } catch (logErr) {
      console.log('⚠️ Failed to log OpenAI request summary', logErr);
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': this.azureOpenAIKey
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let errorBody = '';
      try {
        errorBody = await response.text();
      } catch (readErr) {
        errorBody = `<failed to read error body: ${readErr}>`;
      }
      const enrichedError = new Error(`Azure OpenAI API error: ${response.status} ${response.statusText} - ${errorBody}`) as Error & {
        status?: number;
        body?: string;
        endpointMode?: 'responsesDeployment' | 'responsesGlobal' | 'chatCompletions';
        apiVersion?: string;
      };
      enrichedError.status = response.status;
      enrichedError.body = errorBody;
      enrichedError.endpointMode = mode;
      enrichedError.apiVersion = shouldAppendVersion ? apiVersion : 'default';
      throw enrichedError;
    }

    const rawBody = await response.text();
    const trimmedBody = (rawBody || '').trim();
    const requestId =
      response.headers.get('apim-request-id') ??
      response.headers.get('x-request-id') ??
      response.headers.get('request-id') ??
      undefined;
    const bodyPreview = trimmedBody.substring(0, 500);

    if (!trimmedBody) {
      if (this.verbose) {
        console.error(
          `❌ Empty response body from Azure OpenAI (mode=${mode}, status=${response.status}, requestId=${
            requestId ?? 'n/a'
          }).`
        );
      }
      const emptyBodyError = new Error(
        `Azure OpenAI API returned HTTP 200 but no response body for mode "${mode}". Request ID: ${
          requestId ?? 'unknown'
        }.`
      ) as Error & {
        status?: number;
        body?: string;
        endpointMode?: 'responsesDeployment' | 'responsesGlobal' | 'chatCompletions';
        apiVersion?: string;
      };
      emptyBodyError.status = response.status;
      emptyBodyError.body = '';
      emptyBodyError.endpointMode = mode;
      emptyBodyError.apiVersion = shouldAppendVersion ? apiVersion : 'default';
      throw emptyBodyError;
    }

    let data: any;
    try {
      data = JSON.parse(trimmedBody);
    } catch (parseErr) {
      const parseError = new Error(
        `Failed to parse Azure OpenAI response JSON for mode "${mode}": ${
          parseErr instanceof Error ? parseErr.message : String(parseErr)
        }`
      ) as Error & {
        status?: number;
        body?: string;
        endpointMode?: 'responsesDeployment' | 'responsesGlobal' | 'chatCompletions';
        apiVersion?: string;
      };
      parseError.status = response.status;
      parseError.body = trimmedBody.substring(0, 2000);
      parseError.endpointMode = mode;
      parseError.apiVersion = shouldAppendVersion ? apiVersion : 'default';
      if (this.verbose) {
        console.error(
          `❌ Failed to parse Azure OpenAI response JSON (mode=${mode}, status=${response.status}, requestId=${
            requestId ?? 'n/a'
          }).`
        );
        console.error(`   ↳ Body preview (first 500 chars): ${bodyPreview}`);
        console.error(`   ↳ Parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`);
      }
      (parseError as { requestId?: string }).requestId = requestId;
      throw parseError;
    }

    this.llmCalls++;
    let content = '';

    if (isResponsesMode) {
      content = this.extractResponsesText(data);
    } else {
      content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
    }

    if (!content) {
      if (this.verbose) {
        console.error(
          `❌ Azure OpenAI response contained no textual content (mode=${mode}, status=${response.status}, requestId=${
            requestId ?? 'n/a'
          }).`
        );
        console.error(`   ↳ Raw body preview (first 500 chars): ${bodyPreview}`);
      }
      const missingContentError = new Error(
        `Azure OpenAI API returned HTTP 200 but no textual content for mode "${mode}". Request ID: ${
          requestId ?? 'unknown'
        }.`
      ) as Error & {
        status?: number;
        body?: string;
        endpointMode?: 'responsesDeployment' | 'responsesGlobal' | 'chatCompletions';
        apiVersion?: string;
      };
      missingContentError.status = response.status;
      missingContentError.body = trimmedBody.substring(0, 2000);
      missingContentError.endpointMode = mode;
      missingContentError.apiVersion = shouldAppendVersion ? apiVersion : 'default';
      (missingContentError as { requestId?: string }).requestId = requestId;
      throw missingContentError;
    }

    try {
      if (this.verbose) {
        console.log('🔍 OpenAI response summary:');
        console.log(`  - HTTP status: ${response.status}`);
        console.log(`  - Endpoint Mode: ${mode}`);
        console.log(`  - API Version: ${shouldAppendVersion ? apiVersion : 'default'}`);
        if (isResponsesMode) {
          const outputCount = Array.isArray(data.output) ? data.output.length : 0;
          console.log(`  - Output items: ${outputCount}`);
        } else {
          const choicesCount = Array.isArray(data.choices) ? data.choices.length : 0;
          console.log(`  - Choices: ${choicesCount}`);
        }
        console.log(`  - Response length: ${content ? content.length : 0} chars`);
        if (content) console.log(`  - Response preview (first 600 chars):\n${content.substring(0, 600)}`);
        if (content && content.length > 600) console.log(`  - Response tail preview (last 200 chars):\n${content.substring(content.length - 200)}`);
      }
    } catch (logErr) {
      console.log('⚠️ Failed to log OpenAI response summary', logErr);
    }

    return content;
  }

  private async tryGlobalResponsesEndpoint(prompt: string): Promise<string> {
    return await this.performAzureOpenAIRequest(prompt, 'responsesGlobal', 'fallback');
  }

  private shouldTryGlobalResponsesEndpoint(error: unknown): boolean {
    if (!this.isNotFoundError(error) && !this.isUnsupportedApiVersionError(error)) {
      return false;
    }

    const mode = (error as { endpointMode?: string }).endpointMode;
    return mode === 'responsesDeployment';
  }

  private isNotFoundError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as { status?: number; body?: string; message?: string };
    if (candidate.status !== 404) {
      return false;
    }

    const bodyText = candidate.body || candidate.message || '';
    return /resource not found/i.test(bodyText) || /deployment/i.test(bodyText) || /model/i.test(bodyText);
  }

  private isUnsupportedApiVersionError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }

    const candidate = error as { status?: number; body?: string; message?: string };
    if (candidate.status !== 400) {
      return false;
    }

    const bodyText = candidate.body || candidate.message || '';
    return /api version not supported/i.test(bodyText) || /unsupported api version/i.test(bodyText);
  }

  private shouldUseMaxCompletionTokens(useResponsesEndpoint: boolean = this.useResponsesApi): boolean {
    if (useResponsesEndpoint) {
      return false;
    }

    const match = this.apiVersion.match(/(\d{4})-(\d{2})/);
    if (!match) {
      return false;
    }

    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);

    if (Number.isNaN(year) || Number.isNaN(month)) {
      return false;
    }

    if (year > 2024) {
      return true;
    }

    return year === 2024 && month >= 7;
  }

  private shouldForceDefaultTemperature(useResponsesEndpoint: boolean = this.useResponsesApi): boolean {
    if (useResponsesEndpoint) {
      return true;
    }

    const match = this.apiVersion.match(/(\d{4})-(\d{2})/);
    if (!match) {
      return false;
    }

    const year = parseInt(match[1], 10);
    const month = parseInt(match[2], 10);

    if (Number.isNaN(year) || Number.isNaN(month)) {
      return false;
    }

    if (year > 2024) {
      return true;
    }

    return year === 2024 && month >= 7;
  }

  private extractResponsesText(data: any): string {
    if (!data || typeof data !== 'object') {
      return '';
    }

    const chunks: string[] = [];
    const pushChunk = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(pushChunk);
        return;
      }

      if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed) {
          chunks.push(trimmed);
        }
        return;
      }
    };

    const walkContent = (node: any): void => {
      if (!node) {
        return;
      }

      if (Array.isArray(node)) {
        node.forEach(walkContent);
        return;
      }

      if (typeof node === 'string') {
        pushChunk(node);
        return;
      }

      if (typeof node !== 'object') {
        return;
      }

      if (typeof node.text === 'string') {
        pushChunk(node.text);
      }

      if (typeof node.output_text === 'string' || Array.isArray(node.output_text)) {
        pushChunk(node.output_text);
      }

      if (node.type === 'message' && node.content) {
        walkContent(node.content);
      } else if (node.type === 'output_text' && typeof node.text === 'string') {
        pushChunk(node.text);
      }

      if (node.message && node.message.content) {
        walkContent(node.message.content);
      }

      if (node.content) {
        walkContent(node.content);
      }

      if (node.delta && node.delta.content) {
        walkContent(node.delta.content);
      }
    };

    if (typeof data.output_text === 'string' || Array.isArray(data.output_text)) {
      pushChunk(data.output_text);
    }

    if (data.response) {
      walkContent(data.response);
    }

    if (Array.isArray(data.output)) {
      data.output.forEach((item: any) => walkContent(item));
    }

    if (chunks.length === 0 && Array.isArray(data.choices)) {
      data.choices.forEach((choice: any) => walkContent(choice));
    }

    const uniqueChunks = Array.from(new Set(chunks));
    return uniqueChunks.join('\n').trim();
  }

  private safeJsonParse(jsonString: string, fallback: any): any {
    try {
      // Clean the response first
      let cleanedResponse = jsonString.trim();
      
      // Remove any markdown code blocks
      cleanedResponse = cleanedResponse.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      
      // Try to parse the JSON string
      return JSON.parse(cleanedResponse);
    } catch (parseError) {
      console.log(`⚠️ JSON parsing failed:`, parseError instanceof Error ? parseError.message : String(parseError));
      console.log(`🔍 Raw response:`, jsonString.substring(0, 200));
      
      // Try multiple extraction strategies
      const extractionStrategies = [
        // Strategy 1: Look for JSON object
        () => {
          const jsonMatch = jsonString.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            console.log(`🔄 Strategy 1: Extracting JSON object...`);
            return JSON.parse(jsonMatch[0]);
          }
          return null;
        },
        // Strategy 2: Look for JSON array
        () => {
          const jsonMatch = jsonString.match(/\[[\s\S]*\]/);
          if (jsonMatch) {
            console.log(`🔄 Strategy 2: Extracting JSON array...`);
            return JSON.parse(jsonMatch[0]);
          }
          return null;
        },
        // Strategy 3: Try to find JSON after "```json"
        () => {
          const jsonMatch = jsonString.match(/```json\s*(\{[\s\S]*?\})\s*```/);
          if (jsonMatch) {
            console.log(`🔄 Strategy 3: Extracting from markdown code block...`);
            return JSON.parse(jsonMatch[1]);
          }
          return null;
        },
        // Strategy 4: Try to find JSON after "```"
        () => {
          const jsonMatch = jsonString.match(/```\s*(\{[\s\S]*?\})\s*```/);
          if (jsonMatch) {
            console.log(`🔄 Strategy 4: Extracting from code block...`);
            return JSON.parse(jsonMatch[1]);
          }
          return null;
        }
      ];
      
      for (const strategy of extractionStrategies) {
        try {
          const result = strategy();
          if (result) {
            console.log(`✅ JSON extraction successful`);
            return result;
          }
        } catch (extractError) {
          console.log(`⚠️ Strategy failed:`, extractError instanceof Error ? extractError.message : String(extractError));
        }
      }
      
      // Return fallback if all parsing attempts fail
      console.log(`🔄 All JSON extraction strategies failed, using fallback response structure`);
      return fallback;
    }
  }

  private async analyzeContext(state: PRReviewStateType): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls) {
      return state;
    }

    const contextExternalContext = this.buildExternalContextSection(
      state.external_context,
      {
        heading: 'Additional Context From MCP Servers',
        instruction: 'Consider this context when assessing review priority.'
      }
    );

    const prCtx = state.pr_context;
    let contextPrompt: string;

    if (this.currentCustomInstructions.contextPrompt) {
      contextPrompt = resolveContextPrompt(this.currentCustomInstructions.contextPrompt, {
        repository:      this.currentPRContext.repository,
        prId:            this.currentPRContext.prId,
        prTitle:         prCtx?.title || '',
        prDescription:   prCtx?.description || '',
        sourceBranch:    prCtx?.source_branch || '',
        targetBranch:    prCtx?.target_branch || '',
        changedFiles:    prCtx?.changed_files?.join(', ') || '',
        externalContext: contextExternalContext,
      });
    } else {
      contextPrompt = `You are an expert code reviewer. Analyze the following PR context and determine if a detailed review is needed.

PR Title: ${prCtx?.title || 'N/A'}
PR Description: ${prCtx?.description || 'N/A'}
Changed Files: ${prCtx?.changed_files?.join(', ') || 'N/A'}
${contextExternalContext}

Determine if this PR requires a detailed code review based on:
1. Complexity of changes
2. Risk level
3. Impact on the codebase
4. Quality of the PR description

Respond with JSON:
{
  "requires_review": boolean,
  "reasoning": string,
  "priority": "low" | "medium" | "high",
  "file_suggestions": [
    {
      "file_path": "path/to/file",
      "type": "improvement",
      "description": "What needs to be done in this file",
      "suggestion": "Specific action to take",
      "confidence": 0.9
    }
  ]
}
Note: file_suggestions is optional. Use it to flag files that need attention regardless of requires_review.`;
    }

    try {
      const response = await this.callAzureOpenAI(contextPrompt);
      const analysis = this.safeJsonParse(response, {
        requires_review: true,
        reasoning: "Default review required",
        priority: "medium",
        file_suggestions: []
      });

      if (!analysis.requires_review) {
        state.review_comments.push({
          file: "PR_CONTEXT",
          comment: `No detailed review needed: ${analysis.reasoning}`,
          type: "improvement",
          confidence: 0.9
        });
      }

      if (analysis.file_suggestions && Array.isArray(analysis.file_suggestions)) {
        analysis.file_suggestions.forEach((suggestion: any) => {
          const confidence = suggestion?.confidence ?? 0.9;
          const fileTarget = typeof suggestion?.file_path === 'string' && suggestion.file_path.trim()
            ? suggestion.file_path.trim()
            : 'PR_CONTEXT';
          const type = ['bug', 'improvement', 'security', 'style', 'test'].includes(String(suggestion?.type))
            ? suggestion.type
            : 'improvement';
          const description = suggestion?.description ? String(suggestion.description) : 'File-level suggestion from context analysis.';

          state.review_comments.push({
            file: fileTarget,
            comment: `FILE SUGGESTION: ${description}`,
            type,
            confidence,
            suggestion: suggestion?.suggestion ? String(suggestion.suggestion) : undefined,
            is_new_issue: true
          });
        });
      }

      this.llmCalls++;
      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error analyzing context:", error);
      return state;
    }
  }

  private async reviewFile(state: PRReviewStateType, lineMapping?: Map<number, { originalLine: number; modifiedLine: number; isAdded: boolean; isRemoved: boolean; isContext?: boolean }>): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls || !state.file_content || !state.file_diff) {
      return state;
    }

    // Parse the diff to extract line numbers and changes
    let diffAnalysis = this.analyzeDiff(state.file_diff || '');
    const fileLines = (state.file_content || '').split('\n');

    // If analyzeDiff found no changed lines but a lineMapping was provided by the orchestrator,
    // use that mapping to construct changedContent and addedLines as a fallback so we can still
    // produce focused changed-line context for the LLM.
    if ((diffAnalysis.changedContent.length === 0 || diffAnalysis.addedLines.length === 0) && lineMapping && lineMapping.size > 0) {
      try {
        console.log(`🔄 Fallback: building changedContent from provided lineMapping (entries: ${lineMapping.size})`);
        const addedLines: number[] = [];
        const changedContent: string[] = [];

        // lineMapping keys are diff-line numbers; values have modifiedLine indicating target file line
        for (const [, mapping] of Array.from(lineMapping.entries())) {
          if (mapping.isAdded) {
            const targetLine = mapping.modifiedLine;
            // mapping.modifiedLine is 1-based from parseDiffLineNumbers
            const content = fileLines[targetLine - 1] || '';
            addedLines.push(targetLine);
            changedContent.push(content);
          }
        }

        if (addedLines.length > 0) {
          diffAnalysis = { addedLines, removedLines: [], modifiedLines: [], changedContent };
          console.log(`✅ Built fallback changedContent with ${addedLines.length} added lines from lineMapping`);
        }
      } catch (fbErr) {
        console.log(`⚠️ Failed fallback lineMapping processing:`, fbErr instanceof Error ? fbErr.message : String(fbErr));
      }
    }
    
    const changedLineBlocks = this.buildChangedLineBlocks(diffAnalysis.addedLines, fileLines);
    const changedLinesContext = this.renderBlocksForPrompt(changedLineBlocks);

    console.log(`🔍 Prepared ${changedLineBlocks.length} changed-line blocks for AI context`);

    // If no changed lines, skip the review
    if (diffAnalysis.changedContent.length === 0) {
      console.log(`⏭️ No changed lines found in diff, skipping review for ${state.current_file}`);
      return state;
    }

    const externalContextSection = this.buildExternalContextSection(state.external_context);
    const expandedContext = this.buildExpandedFileContext(fileLines, diffAnalysis.addedLines);
    const changedLineSummary = this.summarizeLineNumbers(diffAnalysis.addedLines);

    const reviewPrompt = this.currentCustomInstructions.reviewPrompt
      ? resolveReviewPrompt(this.currentCustomInstructions.reviewPrompt, {
          repository:      this.currentPRContext.repository,
          prId:            this.currentPRContext.prId,
          prTitle:         this.currentPRContext.prTitle,
          prDescription:   this.currentPRContext.prDescription,
          sourceBranch:    this.currentPRContext.sourceBranch,
          targetBranch:    this.currentPRContext.targetBranch,
          fileName:        state.current_file || '',
          changedLines:    changedLineSummary,
          diff:            state.file_diff || '',
          lineContext:     changedLinesContext || '',
          expandedContext: expandedContext || '',
          externalContext: externalContextSection || '',
        })
      : this.buildDiffPrompt({
      roleIntroduction: `You are an expert code reviewer. Review the diff below and describe any issues in the modified lines of this pull request. Respond with valid JSON only.`,
      fileName: state.current_file,
      changedLineSummary,
      fileDiff: state.file_diff || '',
      changedLinesContext,
      expandedContext,
      externalContextSection,
      instructionsSection: `REVIEW INSTRUCTIONS:
1. Inspect only the lines that begin with "+" in the diff/context—those are the new or updated lines.
2. Use the provided new file line numbers when setting each issue.line_number.
3. Include a code_snippet for every issue that matches the referenced line exactly (whitespace differences are fine).
4. If an issue applies to a file-level policy (or to a different file) and no valid changed line can be identified, add it to file_suggestions with file_path instead of inventing a line number.
5. If there are no problems in the changed lines, return an empty issues array.`,
      jsonResponseReminder: `CRITICAL: You MUST respond with ONLY valid JSON. No markdown, no explanations, no text before or after the JSON. Just the JSON object.`,
      responseSchema: `Use the following JSON schema for your response:
{
  "issues": [
    {
      "type": "bug",
      "severity": "high",
      "description": "Detailed description of the issue",
      "line_number": 15,
      "suggestion": "Specific suggestion for improvement",
      "confidence": 0.9,
      "code_snippet": "const example = 'bad code';",
      "is_new_issue": true
    }
  ],
  "fixed_issues": [
    {
      "description": "Description of the issue that was fixed",
      "line_number": 10,
      "fix_description": "How the issue was addressed"
    }
  ],
  "file_suggestions": [
    {
      "file_path": "path/to/relevant-file",
      "type": "improvement",
      "description": "File-level recommendation when no changed-line anchor is available",
      "suggestion": "Suggested action for that file",
      "confidence": 0.9
    }
  ],
  "overall_quality": "needs_improvement",
  "summary": "Brief summary of the review"
}`,
      criticalRequirements: `1. For each issue, provide the exact line_number from the modified file (or null if it cannot be determined).
2. Include the precise code_snippet for the reported line so the author can verify the problem.
3. Do not fabricate line numbers—set line_number to null and explain why if the mapping is ambiguous.
4. Focus exclusively on the changed lines in this PR; ignore untouched code.
5. Be language aware and explain syntax-driven security risks when relevant.
6. The summary MUST begin with "Detected language: <language guess>."`
        });

    try {
      const response = await this.callAzureOpenAI(reviewPrompt);
      const review = this.safeJsonParse(response, {
        issues: [],
        fixed_issues: [],
        file_suggestions: [],
        overall_quality: "acceptable",
        summary: "Detected language: unknown. Review completed with fallback parsing"
      });
      
      // Add review comments to state with STRICT validation for changed lines only
      if (review.issues && Array.isArray(review.issues)) {
        const groupedIssues = new Map<number, any[]>();

        review.issues.forEach((issue: any) => {
          if (issue.confidence >= this.reviewThreshold) {
            let chosenLine = 0;

            // If the issue already contains a valid changed-line number, prefer it
            if (issue.line_number && diffAnalysis.addedLines.includes(issue.line_number)) {
              chosenLine = issue.line_number;
              console.log(`✅ Issue line ${issue.line_number} is in changed lines - using provided line`);
            } else {
              // Try to heuristically find the best matching line (using code_snippet, description, keywords)
              try {
                const mapped = this.findBestLineNumber(issue, diffAnalysis, state.file_content || '');
                if (mapped && mapped > 0) {
                  chosenLine = mapped;
                  console.log(`🔧 Mapped issue to best line ${chosenLine} using heuristics`);
                } else {
                  console.log(`⚠️ Could not map issue to a changed line using heuristics (issue.line: ${issue.line_number})`);
                }
              } catch (mapErr) {
                console.log(`⚠️ Error while mapping issue to line:`, mapErr instanceof Error ? mapErr.message : String(mapErr));
              }
            }

            if (chosenLine && chosenLine > 0) {
              if (!groupedIssues.has(chosenLine)) {
                groupedIssues.set(chosenLine, []);
              }
              groupedIssues.get(chosenLine)!.push(issue);
            } else {
              const explicitFilePath = typeof issue.file_path === 'string' && issue.file_path.trim()
                ? issue.file_path.trim()
                : '';
              const target = explicitFilePath || 'PR_CONTEXT';
              // If no changed-line anchor exists, use file-level when file_path is explicit; otherwise keep a PR-level comment.
              console.log(`⚠️ Issue missing or outside changed lines: creating ${target === 'PR_CONTEXT' ? 'PR-level' : 'file-level'} suggestion (issue line: ${issue.line_number})`);

              state.review_comments.push({
                file: target,
                // leave line undefined for PR-level comments
                comment: `ISSUE (no valid changed-line): ${issue.description}`,
                type: issue.type,
                confidence: issue.confidence,
                suggestion: issue.suggestion,
                is_new_issue: issue.is_new_issue !== false
              });
            }
          }
        });

        if (groupedIssues.size > 0) {
          for (const [lineNumber, issues] of groupedIssues.entries()) {
            const commentBody = this.combineIssuesForComment(issues, fileLines[lineNumber - 1] || '', lineNumber);
            const primaryIssue = issues[0];

            state.review_comments.push({
              file: state.current_file || "unknown",
          line: lineNumber,
          comment: commentBody,
          type: primaryIssue.type,
          confidence: Math.max(...issues.map((issue: any) => issue.confidence ?? this.reviewThreshold)),
          is_new_issue: issues.every((issue: any) => issue.is_new_issue !== false)
        });
      }
    }
      }

      // Add fixed issues as positive feedback
      if (review.fixed_issues && Array.isArray(review.fixed_issues)) {
        review.fixed_issues.forEach((fixedIssue: any) => {
          if (fixedIssue.line_number && diffAnalysis.addedLines.includes(fixedIssue.line_number)) {
            state.review_comments.push({
              file: state.current_file || "unknown",
              line: fixedIssue.line_number,
              comment: `✅ FIXED: ${fixedIssue.description}\n\n${fixedIssue.fix_description}`,
              type: "improvement",
              confidence: 0.9,
              is_fixed: true
            });
          } else {
            // Create PR-level positive feedback if no valid inline location
            state.review_comments.push({
              file: "PR_CONTEXT",
              comment: `✅ FIXED (PR-level): ${fixedIssue.description} - ${fixedIssue.fix_description}`,
              type: "improvement",
              confidence: 0.9,
              is_fixed: true
            });
          }
        });
      }

      if (review.file_suggestions && Array.isArray(review.file_suggestions)) {
        review.file_suggestions.forEach((suggestion: any) => {
          const confidence = suggestion?.confidence ?? this.reviewThreshold;
          if (confidence < this.reviewThreshold) return;

          const fileTarget = typeof suggestion?.file_path === 'string' && suggestion.file_path.trim()
            ? suggestion.file_path.trim()
            : 'PR_CONTEXT';
          const type = ['bug', 'improvement', 'security', 'style', 'test'].includes(String(suggestion?.type))
            ? suggestion.type
            : 'improvement';
          const description = suggestion?.description ? String(suggestion.description) : 'File-level suggestion generated by review.';

          state.review_comments.push({
            file: fileTarget,
            comment: `FILE SUGGESTION: ${description}`,
            type,
            confidence,
            suggestion: suggestion?.suggestion ? String(suggestion.suggestion) : undefined,
            is_new_issue: suggestion?.is_new_issue !== false
          });
        });
      }

      this.llmCalls++;
      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error reviewing file:", error);
      return state;
    }
  }

  private analyzeDiff(diff: string): { addedLines: number[]; removedLines: number[]; modifiedLines: number[]; changedContent: string[] } {
    const addedLines: number[] = [];
    const removedLines: number[] = [];
    const modifiedLines: number[] = [];
    const changedContent: string[] = [];
    
    if (!diff) {
      return { addedLines, removedLines, modifiedLines, changedContent };
    }

    console.log(`🔍 Analyzing diff (${diff.length} chars):`);
    console.log(`📝 Diff preview: ${diff.substring(0, 200)}...`);

    const lines = diff.split('\n');
    let rightLineNumber = 0;
    let leftLineNumber = 0;
    let inHunk = false;

    for (const line of lines) {
      if (line.startsWith('@@')) {
        // Parse hunk header: @@ -leftStart,leftCount +rightStart,rightCount @@
        const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
        if (match) {
          leftLineNumber = parseInt(match[1]) - 1; // Convert to 0-based
          rightLineNumber = parseInt(match[3]) - 1; // Convert to 0-based
          inHunk = true;
          console.log(`🔍 Hunk: left starts at ${leftLineNumber + 1}, right starts at ${rightLineNumber + 1}`);
        }
      } else if (inHunk) {
        if (line.startsWith('+')) {
          // Added line in the modified file
          rightLineNumber++;
          addedLines.push(rightLineNumber);
          changedContent.push(line.substring(1)); // Remove the + prefix
          console.log(`➕ Added line ${rightLineNumber}: ${line.substring(1).substring(0, 50)}...`);
        } else if (line.startsWith('-')) {
          // Removed line from the original file
          leftLineNumber++;
          removedLines.push(leftLineNumber);
          console.log(`➖ Removed line ${leftLineNumber}: ${line.substring(1).substring(0, 50)}...`);
        } else if (line.startsWith(' ')) {
          // Context line (unchanged)
          leftLineNumber++;
          rightLineNumber++;
        } else if (line.trim() === '') {
          // Empty line
          rightLineNumber++;
        }
      }
    }

    console.log(`✅ Diff analysis complete: ${addedLines.length} added, ${removedLines.length} removed, ${changedContent.length} changed content lines`);
    console.log(`📝 Added lines: ${addedLines.join(', ')}`);
    console.log(`📝 Changed content: ${changedContent.map((line, i) => `Line ${addedLines[i]}: ${line}`).join('\n')}`);
    return { addedLines, removedLines, modifiedLines, changedContent };
  }

  private buildChangedLineBlocks(addedLines: number[], fileLines: string[], contextWindow: number = 2): Array<{ start: number; end: number; lines: Array<{ number: number; text: string; changed: boolean }> }> {
    if (!addedLines || addedLines.length === 0) {
      return [];
    }

    const sorted = Array.from(new Set(addedLines)).sort((a, b) => a - b);
    const changedSet = new Set(sorted);
    const blocks: Array<{ start: number; end: number; lines: Array<{ number: number; text: string; changed: boolean }> }> = [];
    let blockStart = sorted[0];
    let blockEnd = sorted[0];

    const pushBlock = (start: number, end: number) => {
      const startWithContext = Math.max(1, start - contextWindow);
      const endWithContext = Math.min(fileLines.length, end + contextWindow);
      const lines: Array<{ number: number; text: string; changed: boolean }> = [];
      for (let line = startWithContext; line <= endWithContext; line++) {
        lines.push({
          number: line,
          text: fileLines[line - 1] ?? '',
          changed: changedSet.has(line)
        });
      }
      blocks.push({ start: startWithContext, end: endWithContext, lines });
    };

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      if (current <= blockEnd + 1) {
        blockEnd = current;
      } else {
        pushBlock(blockStart, blockEnd);
        blockStart = current;
        blockEnd = current;
      }
    }

    pushBlock(blockStart, blockEnd);
    return blocks;
  }

  private renderBlocksForPrompt(blocks: Array<{ start: number; end: number; lines: Array<{ number: number; text: string; changed: boolean }> }>): string {
    if (!blocks || blocks.length === 0) {
      return '';
    }

    return blocks.map(block => {
      const header = `Lines ${block.start}-${block.end}`;
      const code = block.lines.map(line => {
        const prefix = line.changed ? '+' : ' ';
        return `${prefix}${line.number.toString().padStart(5, ' ')} | ${line.text}`;
      }).join('\n');
      return `${header}\n\`\`\`diff\n${code}\n\`\`\``;
    }).join('\n\n');
  }

  private buildDiffPrompt(options: DiffPromptOptions): string {
    const diffSnippet = this.formatDiffForPrompt(options.fileDiff);
    const formattedDiffSection = `\`\`\`diff\n${diffSnippet}\n\`\`\``;

    const lineContextTrimmed = options.changedLinesContext?.trimEnd();
    const lineContextSection = lineContextTrimmed
      ? `NEW FILE CONTEXT WITH LINE NUMBERS (+ = modified lines):\n${lineContextTrimmed}`
      : '';

    const expandedContextTrimmed = options.expandedContext?.trimEnd();
    const expandedContextSection = expandedContextTrimmed
      ? `ADDITIONAL CONTEXT AROUND CHANGED LINES:\n\`\`\`diff\n${expandedContextTrimmed}\n\`\`\``
      : '';

    const externalContextSection = options.externalContextSection ?? '';

    const contextSections = [lineContextSection, expandedContextSection, externalContextSection]
      .map(section => section ? section.trim() : '')
      .filter(section => section.length > 0);

    const parts: string[] = [];

    parts.push(options.roleIntroduction.trim());
    parts.push('');
    parts.push(`File: ${options.fileName ?? 'unknown'}`);
    parts.push(`Changed line numbers (new file): ${options.changedLineSummary}`);
    parts.push('');
    parts.push('Unified diff ("-" = before, "+" = after):');
    parts.push(formattedDiffSection);
    parts.push('');

    if (contextSections.length > 0) {
      contextSections.forEach(section => {
        parts.push(section);
        parts.push('');
      });
    }

    parts.push(options.instructionsSection.trim());
    parts.push('');
    parts.push(options.jsonResponseReminder.trim());
    parts.push('');
    parts.push(options.responseSchema.trim());
    parts.push('');
    parts.push('CRITICAL REQUIREMENTS:');
    parts.push(options.criticalRequirements.trim());

    while (parts[parts.length - 1] === '') {
      parts.pop();
    }

    return parts.join('\n');
  }

  private formatDiffForPrompt(diff: string, maxLines: number = 300): string {
    if (!diff) {
      return 'Diff unavailable.';
    }

    const trimmed = diff.trim();
    if (!trimmed) {
      return 'Diff unavailable.';
    }

    const lines = trimmed.split('\n');
    if (lines.length <= maxLines) {
      return trimmed;
    }

    const keepStart = Math.max(1, Math.floor(maxLines * 0.6));
    const keepEnd = Math.max(1, maxLines - keepStart);
    if (keepStart + keepEnd >= lines.length) {
      return trimmed;
    }

    const head = lines.slice(0, keepStart);
    const tail = lines.slice(-keepEnd);
    const omitted = lines.length - (keepStart + keepEnd);
    const omissionNotice = `... (diff truncated, ${omitted} omitted line${omitted === 1 ? '' : 's'})`;
    return `${head.join('\n')}\n${omissionNotice}\n${tail.join('\n')}`;
  }

  private summarizeLineNumbers(lines: number[], maxRanges: number = 50): string {
    if (!lines || lines.length === 0) {
      return 'None';
    }

    const sorted = Array.from(new Set(lines)).sort((a, b) => a - b);
    const ranges: Array<{ start: number; end: number }> = [];

    let rangeStart = sorted[0];
    let previous = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      if (current === previous + 1) {
        previous = current;
        continue;
      }

      ranges.push({ start: rangeStart, end: previous });
      rangeStart = current;
      previous = current;
    }

    ranges.push({ start: rangeStart, end: previous });

    const formatted = ranges.map(range =>
      range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`
    );

    if (formatted.length > maxRanges) {
      const visible = formatted.slice(0, maxRanges);
      visible.push(`... (+${formatted.length - maxRanges} more ranges)`);
      return visible.join(', ');
    }

    return formatted.join(', ');
  }

  private buildExpandedFileContext(
    fileLines: string[],
    changedLines: number[],
    contextRadius: number = 40,
    maxCharacters: number = 60000
  ): string {
    if (!fileLines || fileLines.length === 0) {
      return '';
    }

    const totalLines = fileLines.length;
    const sortedChanged = Array.from(new Set(changedLines)).sort((a, b) => a - b);
    const segments: Array<{ start: number; end: number }> = [];

    if (sortedChanged.length === 0) {
      segments.push({
        start: 1,
        end: Math.min(totalLines, contextRadius * 2)
      });
    } else {
      let currentStart = Math.max(1, sortedChanged[0] - contextRadius);
      let currentEnd = Math.min(totalLines, sortedChanged[0] + contextRadius);

      for (let i = 1; i < sortedChanged.length; i++) {
        const line = sortedChanged[i];
        const start = Math.max(1, line - contextRadius);
        const end = Math.min(totalLines, line + contextRadius);

        if (start <= currentEnd + 1) {
          currentEnd = Math.max(currentEnd, end);
        } else {
          segments.push({ start: currentStart, end: currentEnd });
          currentStart = start;
          currentEnd = end;
        }
      }

      segments.push({ start: currentStart, end: currentEnd });
    }

    const changedSet = new Set(sortedChanged);
    let context = '';
    let truncated = false;

    segments.forEach((segment, index) => {
      if (truncated) {
        return;
      }

      const header = `Segment ${index + 1}: lines ${segment.start}-${segment.end}\n`;
      if (context.length + header.length > maxCharacters) {
        truncated = true;
        return;
      }

      context += header;

      for (let lineNumber = segment.start; lineNumber <= segment.end; lineNumber++) {
        const prefix = changedSet.has(lineNumber) ? '+' : ' ';
        const lineText = fileLines[lineNumber - 1] ?? '';
        const entry = `${prefix}${lineNumber.toString().padStart(5, ' ')} | ${lineText}\n`;

        if (context.length + entry.length > maxCharacters) {
          truncated = true;
          break;
        }

        context += entry;
      }

      context += '\n';
    });

    if (truncated) {
      context += '... (context truncated to stay within token limits)\n';
    }

    return context.trimEnd();
  }

  private combineIssuesForComment(issues: any[], lineContent: string, lineNumber: number): string {
    if (!issues || issues.length === 0) {
      return '';
    }

    const parts = issues.map((issue: any, index: number) => {
      const kind = issue.type ? issue.type.toUpperCase() : 'ISSUE';
      const severity = issue.severity ? issue.severity.toUpperCase() : 'N/A';
      const description = issue.description || 'No description provided.';
      const suggestion = issue.suggestion ? `\n\n💡 ${issue.suggestion}` : '';
      return `**${index + 1}. ${kind} (${severity})**\n${description}${suggestion}`;
    });

    const snippet = `\`\`\`diff\n+ ${lineNumber}: ${lineContent}\n\`\`\``;
    return `${parts.join('\n\n')}\n\n${snippet}`;
  }

  private findBestLineNumber(issue: any, diffAnalysis: any, fileContent: string): number {
    console.log(`🔍 Finding best line number for issue:`, {
      type: issue.type,
      description: issue.description?.substring(0, 50),
      hasLineNumber: !!issue.line_number,
      hasCodeSnippet: !!issue.code_snippet,
      addedLines: diffAnalysis.addedLines?.length || 0,
      changedContent: diffAnalysis.changedContent?.length || 0
    });

    // Log the changed content for debugging
    if (diffAnalysis.changedContent && diffAnalysis.changedContent.length > 0) {
      console.log(`📝 Changed content lines:`);
      diffAnalysis.changedContent.forEach((line: string, index: number) => {
        console.log(`  Line ${diffAnalysis.addedLines[index]}: ${line.substring(0, 100)}...`);
      });
    }

    // If the issue already has a line number, validate it first
    if (issue.line_number && issue.line_number > 0) {
      console.log(`🔍 Validating provided line number: ${issue.line_number}`);
      
      // Check if the line number makes sense for the issue
      if (this.validateLineNumberForIssue(issue, issue.line_number, fileContent, diffAnalysis.addedLines)) {
        console.log(`✅ Using validated line number: ${issue.line_number}`);
        return issue.line_number;
      } else {
        console.log(`❌ Line number ${issue.line_number} doesn't match the issue, searching for better match...`);
      }
    }

    // Try to find the line by searching for the code snippet in the changed content first
    if (issue.code_snippet && diffAnalysis.changedContent) {
      const snippet = issue.code_snippet.trim();
      console.log(`🔍 Searching for code snippet: "${snippet}"`);
      for (let i = 0; i < diffAnalysis.changedContent.length; i++) {
        if (diffAnalysis.changedContent[i].includes(snippet)) {
          const lineNumber = diffAnalysis.addedLines[i];
          if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
            console.log(`✅ Found validated code snippet in changed content at line ${lineNumber}`);
            return lineNumber;
          }
        }
      }
      console.log(`❌ Code snippet not found in changed content or validation failed`);
    }

    // Try to find the line by searching for the code snippet in the full file
    if (issue.code_snippet) {
      const snippet = issue.code_snippet.trim();
      console.log(`🔍 Searching for code snippet in full file: "${snippet}"`);
      const lines = fileContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(snippet)) {
          const lineNumber = i + 1;
          if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
            console.log(`✅ Found validated code snippet in full file at line ${lineNumber}`);
            return lineNumber;
          }
        }
      }
      console.log(`❌ Code snippet not found in full file or validation failed`);
    }

    // Try to find by searching for keywords in the changed content
    if (issue.description && diffAnalysis.changedContent) {
      const keywords = issue.description.toLowerCase().split(' ').filter((word: string) => word.length > 3);
      console.log(`🔍 Searching for keywords in changed content:`, keywords);
      for (let i = 0; i < diffAnalysis.changedContent.length; i++) {
        const line = diffAnalysis.changedContent[i].toLowerCase();
        const matchingKeywords = keywords.filter((keyword: string) => line.includes(keyword));
        if (matchingKeywords.length > 0) {
          const lineNumber = diffAnalysis.addedLines[i];
          if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
            console.log(`✅ Found validated keyword match in changed content at line ${lineNumber} (keywords: ${matchingKeywords.join(', ')})`);
            return lineNumber;
          }
        }
      }
      console.log(`❌ No validated keyword matches found in changed content`);
    }

    // Try to find by searching for keywords in the full file
    if (issue.description) {
      const keywords = issue.description.toLowerCase().split(' ').filter((word: string) => word.length > 3);
      console.log(`🔍 Searching for keywords in full file:`, keywords);
      const lines = fileContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase();
        const matchingKeywords = keywords.filter((keyword: string) => line.includes(keyword));
        if (matchingKeywords.length > 0) {
          const lineNumber = i + 1;
          if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
            console.log(`✅ Found validated keyword match in full file at line ${lineNumber} (keywords: ${matchingKeywords.join(', ')})`);
            return lineNumber;
          }
        }
      }
      console.log(`❌ No validated keyword matches found in full file`);
    }

    // Try to find the issue by searching for specific patterns in the full file
    if (issue.description) {
      const description = issue.description.toLowerCase();
      console.log(`🔍 Searching for issue patterns in full file: "${description}"`);
      
      const lines = fileContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase();
        
        // Look for specific patterns based on the issue type - language agnostic
        if (issue.type === 'security') {
          // Look for logging patterns in any language
          if (description.includes('log') && (
            line.includes('console.log') || // JavaScript/TypeScript
            line.includes('print(') || // Python
            line.includes('System.out.println') || // Java
            line.includes('Console.WriteLine') || // C#
            line.includes('printf') || // C/C++
            line.includes('logger.') || // Various logging frameworks
            line.includes('log.') // Various logging frameworks
          )) {
            const lineNumber = i + 1;
            if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
              console.log(`✅ Found validated logging line at ${lineNumber}: ${lines[i].substring(0, 50)}...`);
              return lineNumber;
            }
          }
          
          // Look for endpoint/URL patterns
          if (description.includes('endpoint') && (
            line.includes('endpoint') ||
            line.includes('url') ||
            line.includes('uri') ||
            line.includes('http') ||
            line.includes('https')
          )) {
            const lineNumber = i + 1;
            if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
              console.log(`✅ Found validated endpoint-related line at ${lineNumber}: ${lines[i].substring(0, 50)}...`);
              return lineNumber;
            }
          }
          
          // Look for API key patterns
          if (description.includes('api') && (
            line.includes('api') ||
            line.includes('key') ||
            line.includes('token') ||
            line.includes('secret') ||
            line.includes('password')
          )) {
            const lineNumber = i + 1;
            if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
              console.log(`✅ Found validated API key-related line at ${lineNumber}: ${lines[i].substring(0, 50)}...`);
              return lineNumber;
            }
          }
        }
        
        if (issue.type === 'bug') {
          // Look for syntax issues in any language
          if (description.includes('syntax') && (
            line.includes('{') || line.includes('}') || // Braces
            line.includes('(') || line.includes(')') || // Parentheses
            line.includes('[') || line.includes(']') || // Brackets
            line.includes(';') || // Semicolons
            line.includes('=') || // Assignments
            line.includes('def ') || // Python functions
            line.includes('function ') || // JavaScript functions
            line.includes('public ') || // Java/C# methods
            line.includes('private ') // Java/C# methods
          )) {
            const lineNumber = i + 1;
            if (this.validateLineNumberForIssue(issue, lineNumber, fileContent, diffAnalysis.addedLines)) {
              console.log(`✅ Found validated syntax-related line at ${lineNumber}: ${lines[i].substring(0, 50)}...`);
              return lineNumber;
            }
          }
        }
      }
      console.log(`❌ No validated patterns found in full file`);
    }

    // If we can't find a valid line, return 0 to indicate no valid line found
    console.log(`❌ No valid line found for this issue - returning 0 to skip comment`);
    return 0;
  }

  private validateLineNumberForIssue(issue: any, lineNumber: number, fileContent: string, changedLines: number[]): boolean {
    if (!lineNumber || lineNumber <= 0) return false;
    
    const lines = fileContent.split('\n');
    if (lineNumber > lines.length) return false;
    
    // CRITICAL: Check if the line number is actually in the changed lines
    if (!changedLines.includes(lineNumber)) {
      console.log(`❌ Line ${lineNumber} is NOT in the changed lines. Changed lines: ${changedLines.join(', ')}`);
      return false;
    }
    
    const line = lines[lineNumber - 1];
    const description = issue.description?.toLowerCase() || '';
    const codeSnippet = issue.code_snippet?.toLowerCase() || '';
    
    console.log(`🔍 Validating line ${lineNumber} for issue (line is in changed lines):`, {
      type: issue.type,
      description: description.substring(0, 50),
      codeSnippet: codeSnippet.substring(0, 50),
      actualLine: line.substring(0, 100)
    });
    
    // If we have a code snippet, the line should contain that snippet
    if (codeSnippet && codeSnippet.trim()) {
      const normalizedLine = line.toLowerCase().trim();
      const normalizedSnippet = codeSnippet.trim();
      
      // Check if the line contains the code snippet (with some flexibility for whitespace)
      const snippetWords = normalizedSnippet.split(/\s+/).filter((word: string) => word.length > 0);
      const lineWords = normalizedLine.split(/\s+/).filter((word: string) => word.length > 0);
      
      // Check if most of the snippet words are present in the line
      const matchingWords = snippetWords.filter((snippetWord: string) => 
        lineWords.some((lineWord: string) => lineWord.includes(snippetWord) || snippetWord.includes(lineWord))
      );
      
      const matchRatio = matchingWords.length / snippetWords.length;
      
      if (matchRatio < 0.5) { // At least 50% of words should match
        console.log(`❌ Line ${lineNumber} doesn't contain the code snippet. Match ratio: ${matchRatio.toFixed(2)}`);
        console.log(`❌ Expected: "${codeSnippet}"`);
        console.log(`❌ Actual: "${line}"`);
        return false;
      }
      
      console.log(`✅ Line ${lineNumber} contains the code snippet. Match ratio: ${matchRatio.toFixed(2)}`);
      return true;
    }
    
    // If no code snippet, check if the line contains keywords from the description
    if (description) {
      const descriptionWords = description.split(/\s+/)
        .filter((word: string) => word.length > 3) // Only meaningful words
        .map((word: string) => word.toLowerCase());
      
      const lineWords = line.toLowerCase().split(/\s+/);
      
      // Check if any significant words from the description appear in the line
      const matchingKeywords = descriptionWords.filter((descWord: string) => 
        lineWords.some((lineWord: string) => lineWord.includes(descWord) || descWord.includes(lineWord))
      );
      
      if (matchingKeywords.length === 0) {
        console.log(`❌ Line ${lineNumber} doesn't contain any keywords from the issue description`);
        console.log(`❌ Description keywords: ${descriptionWords.join(', ')}`);
        console.log(`❌ Line content: "${line}"`);
        return false;
      }
      
      console.log(`✅ Line ${lineNumber} contains relevant keywords: ${matchingKeywords.join(', ')}`);
      return true;
    }
    
    // If no code snippet or description, we can't validate - return false to be safe
    console.log(`❌ No code snippet or description available for validation`);
    return false;
  }

  private async securityScan(state: PRReviewStateType, lineMapping?: Map<number, { originalLine: number; modifiedLine: number; isAdded: boolean; isRemoved: boolean; isContext?: boolean }>): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls) {
      return state;
    }

    if (!state.file_content) {
      return state;
    }

    // Parse the diff to extract line numbers and changes
    let diffAnalysis = this.analyzeDiff(state.file_diff || '');

    // Fallback to provided lineMapping if no changed lines were found
    if ((diffAnalysis.changedContent.length === 0 || diffAnalysis.addedLines.length === 0) && lineMapping && lineMapping.size > 0) {
      try {
        const fileLines = (state.file_content || '').split('\n');
        const addedLines: number[] = [];
        const changedContent: string[] = [];
        for (const [, mapping] of Array.from(lineMapping.entries())) {
          if (mapping.isAdded) {
            const targetLine = mapping.modifiedLine;
            const content = fileLines[targetLine - 1] || '';
            addedLines.push(targetLine);
            changedContent.push(content);
          }
        }
        if (addedLines.length > 0) {
          diffAnalysis = { addedLines, removedLines: [], modifiedLines: [], changedContent };
          console.log(`✅ Security scan fallback: built changedContent from lineMapping with ${addedLines.length} lines`);
        }
      } catch (fbErr) {
        console.log(`⚠️ Security scan fallback failed:`, fbErr instanceof Error ? fbErr.message : String(fbErr));
      }
    }

    const securityFileLines = (state.file_content || '').split('\n');
    const securityBlocks = this.buildChangedLineBlocks(diffAnalysis.addedLines, securityFileLines);
    const changedLinesContext = this.renderBlocksForPrompt(securityBlocks);

    console.log(`🔍 Security scan - prepared ${securityBlocks.length} changed-line blocks for AI context`);

    // If no changed lines, skip the security scan
    if (diffAnalysis.changedContent.length === 0) {
      console.log(`⏭️ No changed lines found in diff, skipping security scan for ${state.current_file}`);
      return state;
    }

    const securityExternalContext = this.buildExternalContextSection(state.external_context);
    const expandedContext = this.buildExpandedFileContext(securityFileLines, diffAnalysis.addedLines);
    const changedLineSummary = this.summarizeLineNumbers(diffAnalysis.addedLines);

    const securityPrompt = this.currentCustomInstructions.securityPrompt
      ? resolveReviewPrompt(this.currentCustomInstructions.securityPrompt, {
          repository:      this.currentPRContext.repository,
          prId:            this.currentPRContext.prId,
          prTitle:         this.currentPRContext.prTitle,
          prDescription:   this.currentPRContext.prDescription,
          sourceBranch:    this.currentPRContext.sourceBranch,
          targetBranch:    this.currentPRContext.targetBranch,
          fileName:        state.current_file || '',
          changedLines:    changedLineSummary,
          diff:            state.file_diff || '',
          lineContext:     changedLinesContext || '',
          expandedContext: expandedContext || '',
          externalContext: securityExternalContext || '',
        })
      : this.buildDiffPrompt({
      roleIntroduction: `You are a security-focused code reviewer. Examine the diff below and report any vulnerabilities in the modified lines. Respond with valid JSON only.`,
      fileName: state.current_file,
      changedLineSummary,
      fileDiff: state.file_diff || '',
      changedLinesContext,
      expandedContext,
      externalContextSection: securityExternalContext,
      instructionsSection: `SECURITY REVIEW INSTRUCTIONS:
1. Inspect only the lines that begin with "+"—those are the newly introduced or updated lines.
2. Use the provided new file line numbers when setting each issue.line_number.
3. Recommend clear remediations for every finding.
4. Return an empty security_issues array if no problems are present.

PRIMARY SECURITY CHECKS:
- Hardcoded secrets or credentials
- Logging of sensitive information
- Input validation or sanitization gaps
- Injection vulnerabilities (SQL, XSS, command, etc.)
- Authentication / authorization mistakes
- Insecure cryptographic or dependency usage
- Prompt-injection risks when handling LLM input/output

LANGUAGE AWARENESS:
- Identify the most likely language before evaluating the code.
- Apply that language's syntax and idioms when judging security implications.
- If the syntax is invalid or obviously unsafe, flag it with high severity and explain the risk.`,
      jsonResponseReminder: `CRITICAL: Respond with ONLY valid JSON. No markdown, no explanations, no text before or after the JSON. Just the JSON object.`,
      responseSchema: `Return JSON with this shape:
{
  "detected_language": "C#",
  "security_issues": [
    {
      "vulnerability_type": "SQL Injection",
      "severity": "high",
      "description": "User input is directly concatenated into SQL query",
      "line_number": 25,
      "recommendation": "Use parameterized queries",
      "confidence": 0.9,
      "code_snippet": "const query = 'SELECT * FROM users WHERE id = ' + userId;"
    }
  ],
  "overall_security_score": "C"
}`,
      criticalRequirements: `1. For each security issue, provide the exact line_number from the modified file (or null if you cannot determine it).
2. Include the code_snippet for the vulnerable line so the author can verify the problem.
3. Do not fabricate line numbers—set line_number to null and explain why if mapping is ambiguous.
4. Focus exclusively on the changed lines in this PR; ignore untouched code.
5. Be language aware and explain any syntax-driven security risks.
6. Include a top-level "detected_language" field describing the language you analyzed.`
        });

    try {
      const response = await this.callAzureOpenAI(securityPrompt);
      const securityAnalysis = this.safeJsonParse(response, {
        detected_language: "unknown",
        security_issues: [],
        overall_security_score: "B"
      });
      
      if (securityAnalysis.security_issues && Array.isArray(securityAnalysis.security_issues)) {
        const groupedSecurityIssues = new Map<number, any[]>();

        securityAnalysis.security_issues.forEach((issue: any) => {
          if (issue.confidence >= this.reviewThreshold) {
            let chosenLine = 0;

            // Prefer provided line if valid
            if (issue.line_number && diffAnalysis.addedLines.includes(issue.line_number)) {
              chosenLine = issue.line_number;
              console.log(`✅ Security issue line ${issue.line_number} is in changed lines - using provided line`);
            } else {
              // Attempt heuristic mapping for security issues too
              try {
                const mapped = this.findBestLineNumber(issue, diffAnalysis, state.file_content || '');
                if (mapped && mapped > 0) {
                  chosenLine = mapped;
                  console.log(`🔧 Mapped security issue to best line ${chosenLine} using heuristics`);
                } else {
                  console.log(`❌ Security issue line ${issue.line_number} is NOT in changed lines (${diffAnalysis.addedLines.join(', ')}) - will skip inline posting`);
                }
              } catch (mapErr) {
                console.log(`⚠️ Error while mapping security issue to line:`, mapErr instanceof Error ? mapErr.message : String(mapErr));
              }
            }

            if (chosenLine && chosenLine > 0) {
              if (!groupedSecurityIssues.has(chosenLine)) {
                groupedSecurityIssues.set(chosenLine, []);
              }
              groupedSecurityIssues.get(chosenLine)!.push(issue);
            } else {
              console.log(`❌ Security issue could not be mapped to a changed line - SKIPPING inline comment`);
            }
          }
        });

        if (groupedSecurityIssues.size > 0) {
          for (const [lineNumber, issues] of groupedSecurityIssues.entries()) {
            const formatted = issues.map((issue: any) => ({
              type: 'security',
              severity: issue.severity || 'medium',
              description: issue.description,
              suggestion: issue.recommendation,
              confidence: issue.confidence ?? this.reviewThreshold
            }));

            const commentBody = this.combineIssuesForComment(formatted, securityFileLines[lineNumber - 1] || '', lineNumber);

            state.review_comments.push({
              file: state.current_file || "unknown",
              line: lineNumber,
              comment: commentBody,
              type: "security",
              confidence: Math.max(...formatted.map((item: any) => item.confidence)),
              is_new_issue: issues.every((issue: any) => issue.is_new_issue !== false)
            });
          }
        }
      }

      this.llmCalls++;
      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error in security scan:", error);
      return state;
    }
  }

  private async generateSuggestions(state: PRReviewStateType): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls) {
      return state;
    }

    if (state.review_comments.length === 0) {
      return state;
    }

    const commentsJson = JSON.stringify(state.review_comments, null, 2);

    let suggestionsPrompt: string;
    if (this.currentCustomInstructions.suggestionsPrompt) {
      suggestionsPrompt = resolveSuggestionsPrompt(this.currentCustomInstructions.suggestionsPrompt, {
        repository:      this.currentPRContext.repository,
        prId:            this.currentPRContext.prId,
        prTitle:         this.currentPRContext.prTitle,
        prDescription:   this.currentPRContext.prDescription,
        sourceBranch:    this.currentPRContext.sourceBranch,
        targetBranch:    this.currentPRContext.targetBranch,
        reviewComments:  commentsJson,
      });
    } else {
      suggestionsPrompt = `Based on the following review comments, generate specific code improvement suggestions:

Review Comments: ${commentsJson}

For each comment that has a suggestion, provide:
1. The exact code change needed
2. Before/after examples
3. Explanation of why this improves the code
4. Any additional considerations

Format as JSON:
{
  "suggestions": [
    {
      "comment_id": number,
      "code_change": {
        "before": string,
        "after": string
      },
      "explanation": string,
      "considerations": string[]
    }
  ]
}`;
    }

    try {
      const response = await this.callAzureOpenAI(suggestionsPrompt);
      const suggestions = this.safeJsonParse(response, {
        suggestions: []
      });
      
      // Update review comments with suggestions
      if (suggestions.suggestions && Array.isArray(suggestions.suggestions)) {
        suggestions.suggestions.forEach((suggestion: any) => {
          const commentIndex = suggestion.comment_id;
          if (state.review_comments[commentIndex]) {
            state.review_comments[commentIndex].suggestion = 
              `Code Change:\nBefore: ${suggestion.code_change.before}\nAfter: ${suggestion.code_change.after}\n\nExplanation: ${suggestion.explanation}`;
          }
        });
      }

      this.llmCalls++;
      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error generating suggestions:", error);
      return state;
    }
  }

  private async finalizeReview(state: PRReviewStateType): Promise<PRReviewStateType> {
    if (this.llmCalls >= this.maxLLMCalls) {
      return state;
    }

    const reviewCommentsJson = JSON.stringify(state.review_comments, null, 2);

    let finalizationPrompt: string;
    if (this.currentCustomInstructions.finalizationPrompt) {
      finalizationPrompt = resolveFinalizationPrompt(this.currentCustomInstructions.finalizationPrompt, {
        repository:      this.currentPRContext.repository,
        prId:            this.currentPRContext.prId,
        prTitle:         this.currentPRContext.prTitle,
        prDescription:   this.currentPRContext.prDescription,
        sourceBranch:    this.currentPRContext.sourceBranch,
        targetBranch:    this.currentPRContext.targetBranch,
        reviewComments:  reviewCommentsJson,
        totalIssues:     String(state.review_comments.length),
        llmCallsUsed:    String(this.llmCalls),
        maxLlmCalls:     String(this.maxLLMCalls),
      });
    } else {
      finalizationPrompt = `Based on all the review comments and analysis, provide a final summary and recommendation:

Review Summary: ${reviewCommentsJson}
Total Issues Found: ${state.review_comments.length}
LLM Calls Used: ${this.llmCalls}/${this.maxLLMCalls}

Provide a final recommendation in JSON format:
{
  "overall_assessment": "approve" | "approve_with_suggestions" | "request_changes",
  "summary": "Overall summary of the review",
  "key_issues": "List of the most important issues found",
  "recommendations": "Specific recommendations for the PR author",
  "confidence": number (0.0-1.0)
}`;
    }

    try {
      const response = await this.callAzureOpenAI(finalizationPrompt);
      const finalAssessment = this.safeJsonParse(response, {
        overall_assessment: "approve_with_suggestions",
        summary: "Review completed with fallback parsing",
        key_issues: "Issues found during review",
        recommendations: "Consider the review comments provided",
        confidence: 0.7
      });
      
      // Store final assessment in state for summary generation (not as a comment)
      state.final_assessment = {
        overall_assessment: finalAssessment.overall_assessment,
        summary: finalAssessment.summary,
        key_issues: finalAssessment.key_issues,
        recommendations: finalAssessment.recommendations,
        confidence: finalAssessment.confidence
      };

      this.llmCalls++;
      state.llm_calls = this.llmCalls;
      return state;
    } catch (error) {
      console.error("Error finalizing review:", error);
      return state;
    }
  }

  private buildExternalContextSection(
    contextItems?: string[],
    options?: {
      heading?: string;
      maxItems?: number;
      instruction?: string;
      includeInstruction?: boolean;
    }
  ): string {
    if (!contextItems || contextItems.length === 0) {
      return '';
    }

    const maxItems = Math.max(1, options?.maxItems ?? 5);
    const heading = options?.heading ?? 'ADDITIONAL CONTEXT FROM MCP SERVERS';
    const instruction = options?.instruction ?? 'Incorporate relevant details from this context when reviewing the changes.';
    const includeInstruction = options?.includeInstruction ?? true;

    const limitedItems = contextItems
      .slice(0, maxItems)
      .map(item => item?.trim())
      .filter((item): item is string => Boolean(item));

    if (limitedItems.length === 0) {
      return '';
    }

    const formattedItems = limitedItems
      .map((item, index) => `CONTEXT ${index + 1}:\n${item}`)
      .join('\n\n');

    const omittedCount = contextItems.length - limitedItems.length;
    const omissionNotice = omittedCount > 0
      ? `\n\nNote: ${omittedCount} additional context item(s) were omitted for brevity.`
      : '';

    const instructionText = includeInstruction ? `\n${instruction}` : '';
    return `\n${heading}:\n${formattedItems}${omissionNotice}${instructionText}\n`;
  }

  public getLLMCallCount(): number {
    return this.llmCalls;
  }
}
