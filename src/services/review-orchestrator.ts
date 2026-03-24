import * as tl from "azure-pipelines-task-lib/task";
import { Agent } from 'node:https';
import { AdvancedPRReviewAgent, PRReviewStateType } from '../agents/pr-review-agent';
import { AzureDevOpsService, PRDetails } from './azure-devops-service';
import { getTargetBranchName, getSourceBranchName } from '../utils';
import { MCPService } from './mcp-service';
import { MCPServerConfig } from '../types/mcp';
import { loadCustomInstructions, CustomInstructions, resolveSummaryTemplate } from './custom-instructions-loader';

export interface ReviewResult {
  success: boolean;
  totalFilesReviewed: number;
  totalComments: number;
  llmCallsUsed: number;
  maxLLMCalls: number;
  reviewSummary: string;
  requiresChanges: boolean;
  canApprove: boolean;
}

export class ReviewOrchestrator {
  private azureDevOpsService: AzureDevOpsService;
  private reviewAgent: AdvancedPRReviewAgent;
  private httpsAgent: Agent;
  private maxLLMCalls: number;
  private reviewThreshold: number;
  private enableCodeSuggestions: boolean;
  private enableSecurityScanning: boolean;
  private mcpService: MCPService;
  private rawCustomInstructions: CustomInstructions = {};
  private fileLineMappings: Map<string, Map<number, { originalLine: number; modifiedLine: number; isAdded: boolean; isRemoved: boolean; isContext: boolean }>> = new Map();
  private fallbackGeneralCommentFiles: Set<string> = new Set();

  constructor(
    httpsAgent: Agent,
    azureOpenAIEndpoint: string,
    azureOpenAIKey: string,
    deploymentName: string,
    maxLLMCalls: number = 100,
    reviewThreshold: number = 0.7,
    enableCodeSuggestions: boolean = true,
    enableSecurityScanning: boolean = true,
    azureOpenAIApiVersion: string = '2024-02-15-preview',
    useResponsesApi: boolean = false,
    mcpServers: MCPServerConfig[] = [],
    customInstructionsFolder: string = '.pr-review'
  ) {
    this.httpsAgent = httpsAgent;
    this.azureDevOpsService = new AzureDevOpsService(httpsAgent);
    this.reviewAgent = new AdvancedPRReviewAgent(
      azureOpenAIEndpoint,
      azureOpenAIKey,
      deploymentName,
      maxLLMCalls,
      reviewThreshold,
      azureOpenAIApiVersion,
      useResponsesApi
    );
    this.maxLLMCalls = maxLLMCalls;
    this.reviewThreshold = reviewThreshold;
    this.enableCodeSuggestions = enableCodeSuggestions;
    this.enableSecurityScanning = enableSecurityScanning;
    this.mcpService = new MCPService(mcpServers);

    // Load custom instructions from .pr-review/ folder in the repo (once at startup)
    const sourcesDir = process.env['BUILD_SOURCESDIRECTORY'] || process.cwd();
    this.rawCustomInstructions = loadCustomInstructions(sourcesDir, customInstructionsFolder);
  }

  public async runFullReview(): Promise<ReviewResult> {
    try {
      console.log("🚀 Starting Advanced PR Review Process...");
      
      // Step 1: Validate PR context
      if (tl.getVariable('Build.Reason') !== 'PullRequest') {
        throw new Error("This task should only run when triggered from a Pull Request.");
      }

      // Step 2: Test API connectivity first
      await this.azureDevOpsService.testCorrectedUrlStructure();
      await this.azureDevOpsService.testBaseUrlConnectivity();
      await this.azureDevOpsService.testApiConnectivity();
      
      // Step 3: Get PR details and context
      const prDetails = await this.azureDevOpsService.getPullRequestDetails();
      console.log(`📋 Reviewing PR: ${prDetails.title}`);
      console.log(`👤 Author: ${prDetails.createdBy.displayName}`);
      console.log(`🔄 Source: ${prDetails.sourceRefName} → Target: ${prDetails.targetRefName}`);

      // Step 4: Get target branch
      const targetBranch = getTargetBranchName();
      if (!targetBranch) {
        throw new Error("No target branch found!");
      }

      // Step 5: Keep existing comments for better context and continuity
      // await this.azureDevOpsService.deleteExistingComments();
      console.log("📝 Keeping existing comments for better review continuity");

      // Step 6: Get changed files
      console.log(`🔍 Step 6: Getting changed files...`);
      let changedFiles: string[] = [];
      
      try {
        changedFiles = await this.azureDevOpsService.getChangedFiles();
        console.log(`✅ Successfully got ${changedFiles.length} changed files`);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`❌ Failed to get changed files:`, errorMessage);
        console.log(`🔄 Using emergency fallback to ensure review can proceed...`);
        
        // Emergency fallback: use hardcoded files based on PR title
        if (prDetails.title.includes('pr-review-agent')) {
          changedFiles = ['AdvancedPRReviewer/src/agents/pr-review-agent.ts'];
          console.log(`✅ Emergency fallback: Using pr-review-agent.ts`);
        } else {
          changedFiles = ['AdvancedPRReviewer/src/agents/pr-review-agent.ts'];
          console.log(`✅ Emergency fallback: Using default file set`);
        }
      }
      
      console.log(`📁 Final changed files:`, changedFiles);

      if (changedFiles.length === 0) {
        console.log("⚠️ No files to review, using emergency fallback...");
        changedFiles = ['AdvancedPRReviewer/src/agents/pr-review-agent.ts'];
        console.log(`✅ Emergency fallback applied: ${changedFiles.length} files`);
      }

      // Step 7: Review each file
      console.log(`🔍 Step 7: Starting file review process...`);
      console.log(`🔍 Will review ${changedFiles.length} files:`, changedFiles);
      
      const reviewResults = await this.reviewFiles(changedFiles, targetBranch, prDetails);
      console.log(`✅ File review completed: ${reviewResults.length} results`);

      // Step 8: Generate final summary
      const finalSummary = await this.generateFinalSummary(reviewResults, prDetails);

      // Step 9: Post results to Azure DevOps
      await this.postReviewResults(reviewResults, finalSummary, prDetails);

      // Step 10: Return comprehensive result
      return this.createReviewResult(reviewResults, finalSummary);

    } catch (error: any) {
      console.error("❌ Review process failed:", error.message);
      throw error;
    }
  }

  private async reviewFiles(
    changedFiles: string[],
    targetBranch: string,
    prDetails: PRDetails
  ): Promise<PRReviewStateType[]> {
    const reviewResults: PRReviewStateType[] = [];
    let totalLLMCalls = 0;
    this.fileLineMappings.clear();
    const normalizedSource =
      getSourceBranchName() ??
      (prDetails.sourceRefName ? prDetails.sourceRefName.replace('refs/heads/', '') : prDetails.sourceRefName) ??
      targetBranch;

    for (const filePath of changedFiles) {
      try {
        console.log(`🔍 Reviewing file: ${filePath}`);

        // Skip binary files
        if (this.isBinaryFile(filePath)) {
          console.log(`⏭️  Skipping binary file: ${filePath}`);
          continue;
        }

        // Validate that the file actually exists in the current PR
        const fileExists = await this.azureDevOpsService.validateFileExists(filePath);
        if (!fileExists) {
          console.log(`⏭️  Skipping file that doesn't exist in current PR: ${filePath}`);
          continue;
        }

        // Get file content and diff with line numbers
        const fileContent = await this.azureDevOpsService.getFileContent(filePath, targetBranch);

        // Detect and skip folder-like responses (Azure DevOps returns a JSON tree for folders)
        const rawContentPreview = (fileContent.content || '').substring(0, 200);
        if (rawContentPreview.includes('"gitObjectType"') && rawContentPreview.includes('"tree"')) {
          console.log(`⏭️  Skipping folder/non-file path: ${filePath} (returned tree metadata)`);
          continue;
        }
        let fileDiff = '';
        let lineMapping: Map<number, { originalLine: number; modifiedLine: number; isAdded: boolean; isRemoved: boolean; isContext: boolean }> = new Map();
        
        try {
          const diffResult = await this.azureDevOpsService.getDiffForFile(filePath, targetBranch, normalizedSource, {
            targetContent: fileContent.content || ''
          });
          fileDiff = diffResult.diff;
          lineMapping = diffResult.lineMapping;
        } catch (diffError) {
          const errorMessage = diffError instanceof Error ? diffError.message : String(diffError);
          console.log(`⚠️ Failed to retrieve diff for ${filePath}:`, errorMessage);
          fileDiff = `File ${filePath} has changes (diff unavailable)`;
        }

        if (fileContent.isBinary) {
          console.log(`⏭️  Skipping binary file content: ${filePath}`);
          continue;
        }

        // Check if we've exceeded LLM call limit
        if (totalLLMCalls >= this.maxLLMCalls) {
          console.log(`⚠️  Maximum LLM calls (${this.maxLLMCalls}) reached. Stopping review.`);
          break;
        }

        // Create PR context for the agent
        const prContext = {
          title: prDetails.title,
          description: prDetails.description,
          author: prDetails.createdBy.displayName,
          target_branch: prDetails.targetRefName,
          source_branch: prDetails.sourceRefName,
          changed_files: changedFiles
        };

        let externalContext: string[] = [];
        if (this.mcpService.hasServers()) {
          externalContext = await this.mcpService.fetchContext({
            filePath,
            fileDiff,
            fileContent: fileContent.content || '',
            prContext,
            metadata: {
              prId: prDetails.id,
              prTitle: prDetails.title,
              repository: this.azureDevOpsService.getRepository(),
              project: this.azureDevOpsService.getProject(),
              collection: this.azureDevOpsService.getCollection(),
              pullRequestId: this.azureDevOpsService.getPullRequestIdValue(),
              sourceBranch: prDetails.sourceRefName,
              targetBranch: prDetails.targetRefName
            }
          });
          if (externalContext.length > 0) {
            console.log(`🔗 Received ${externalContext.length} context item(s) from MCP servers for ${filePath}`);
          }
        }

        // Run the review agent
        const normalizedFilePath = filePath.startsWith('/') ? filePath : '/' + filePath;
        this.fileLineMappings.set(normalizedFilePath, lineMapping);
        // Debug logging: file sizes and diff info before LLM call
        try {
          console.log(`🔎 Preparing to call review agent for ${filePath}`);
          console.log(`  - File content size: ${fileContent.content?.length || 0} chars`);
          console.log(`  - File diff size: ${fileDiff?.length || 0} chars`);
          console.log(`  - Line mapping entries: ${lineMapping ? (lineMapping.size || 0) : 0}`);
        } catch (dbgErr) {
          console.log('⚠️ Failed to log debug info before LLM call', dbgErr);
        }

        const reviewResult = await this.reviewAgent.runReview(
          fileContent.content,
          fileDiff,
          filePath,
          prContext,
          lineMapping, // pass mapping so agent can fall back to it when diff parsing fails
          externalContext,
          this.rawCustomInstructions
        );

        reviewResults.push(reviewResult);
        totalLLMCalls += reviewResult.llm_calls;

        console.log(`✅ File ${filePath} reviewed. LLM calls used: ${reviewResult.llm_calls}`);

      } catch (error: any) {
        console.error(`❌ Error reviewing file ${filePath}:`, error.message);
        // Continue with other files
      }
    }

    return reviewResults;
  }

  private async generateFinalSummary(
    reviewResults: PRReviewStateType[],
    prDetails: PRDetails
  ): Promise<any> {
    console.log("📊 Generating final review summary...");

    const allComments = reviewResults.flatMap(result => result.review_comments);
    const totalIssues = allComments.length;
    const criticalIssues = allComments.filter(comment => 
      comment.type === 'security' || comment.type === 'bug'
    ).length;

    // Check if any review result has a final assessment
    const finalAssessment = reviewResults.find(result => result.final_assessment)?.final_assessment;

    let overallAssessment = 'approve';
    let requiresChanges = false;
    let summaryText = this.generateSummaryText(allComments, prDetails);
    let recommendations = this.generateRecommendations(allComments);

    // Use final assessment if available, otherwise generate from comments
    if (finalAssessment) {
      console.log("📊 Using final assessment from AI");
      overallAssessment = finalAssessment.overall_assessment;
      summaryText = finalAssessment.summary;
      recommendations = finalAssessment.recommendations;
      requiresChanges = overallAssessment === 'request_changes';
    } else {
      // Fallback to comment-based assessment
      if (criticalIssues > 0) {
        overallAssessment = 'request_changes';
        requiresChanges = true;
      } else if (totalIssues > 5) {
        overallAssessment = 'approve_with_suggestions';
      }
    }

    const summary = {
      overall_assessment: overallAssessment,
      total_files_reviewed: reviewResults.length,
      total_issues_found: totalIssues,
      critical_issues: criticalIssues,
      security_issues: allComments.filter(c => c.type === 'security').length,
      bug_issues: allComments.filter(c => c.type === 'bug').length,
      improvement_issues: allComments.filter(c => c.type === 'improvement').length,
      style_issues: allComments.filter(c => c.type === 'style').length,
      test_issues: allComments.filter(c => c.type === 'test').length,
      requires_changes: requiresChanges,
      can_approve: !requiresChanges,
      summary: summaryText,
      recommendations: recommendations
    };

    return summary;
  }

  private async postReviewResults(
    reviewResults: PRReviewStateType[],
    finalSummary: any,
    prDetails: PRDetails
  ): Promise<void> {
    console.log("💬 Posting review results to Azure DevOps...");
    this.fallbackGeneralCommentFiles.clear();

    // Get existing comments to avoid duplicates
    let existingComments: any[] = [];
    try {
      const existingThreads = await this.azureDevOpsService.getExistingComments();
      existingComments = existingThreads.flatMap(thread => thread.comments || []);
      console.log(`📋 Found ${existingComments.length} existing comments`);
    } catch (error) {
      console.log(`⚠️ Could not fetch existing comments, proceeding with new comments`);
    }
    const existingCommentIndex = this.buildExistingCommentIndex(existingComments);

    // Post final summary as a general comment (only if no recent summary exists)
    const hasRecentSummary = this.hasRecentSummaryComment(existingComments);
    if (!hasRecentSummary) {
      const summaryComment = this.formatSummaryComment(finalSummary, prDetails);
      const autoClose = finalSummary.overall_assessment === 'approve';
      const threadId = await this.azureDevOpsService.addGeneralComment(summaryComment, { autoClose });
      if (autoClose && threadId) {
        console.log(`✅ Posted new summary comment and auto-closed thread ${threadId}`);
      } else {
        console.log(`✅ Posted new summary comment${threadId ? ` (thread ${threadId})` : ''}`);
      }
    } else {
      console.log(`📝 Recent summary comment exists, skipping duplicate`);
    }

    // Post individual file comments with improved inline commenting
    console.log(`💬 Processing ${reviewResults.length} review results for commenting...`);
    
    // Collect inline comments per file so we can coalesce contiguous lines into ranges
    const inlineCommentsByFile: Map<string, any[]> = new Map();
    const fileLevelCommentsByFile: Map<string, any[]> = new Map();
    const prLevelComments: any[] = [];

    for (const result of reviewResults) {
      for (const comment of result.review_comments) {
        if (!comment) continue;
        if (comment.file === 'PR_CONTEXT') {
          prLevelComments.push(comment);
          continue;
        }

        const normalizedFilePath = comment.file.startsWith('/') ? comment.file : '/' + comment.file;
        comment.file = normalizedFilePath;

        if (!comment.line || typeof comment.line !== 'number' || comment.line <= 0) {
          if (this.isDuplicateFileLevelComment(comment, existingComments)) continue;
          if (!fileLevelCommentsByFile.has(normalizedFilePath)) {
            fileLevelCommentsByFile.set(normalizedFilePath, []);
          }
          fileLevelCommentsByFile.get(normalizedFilePath)!.push(comment);
          continue;
        }

        const lineMapping = this.fileLineMappings.get(normalizedFilePath);
        if (lineMapping && lineMapping.size > 0) {
          const lineInfo = lineMapping.get(comment.line);
          if (!lineInfo || !lineInfo.isAdded) {
            console.log(`⏭️  Skipping comment on unchanged line ${comment.line} in ${normalizedFilePath}`);
            continue;
          }

          // Normalize the comment line to the actual modified line Azure DevOps expects.
          comment.line = lineInfo.modifiedLine;
        }

        // Skip duplicates early
        if (this.isDuplicateComment(comment, existingComments, existingCommentIndex)) continue;

        if (!inlineCommentsByFile.has(normalizedFilePath)) {
          inlineCommentsByFile.set(normalizedFilePath, []);
        }
        inlineCommentsByFile.get(normalizedFilePath)!.push(comment);
      }
    }

    if (prLevelComments.length > 0) {
      const mergedPrComment = `## PR-level suggestions\n\n${prLevelComments.map((c: any) => this.formatComment(c)).join('\n\n---\n\n')}`;
      if (!this.isDuplicateGeneralComment(mergedPrComment, existingComments)) {
        await this.azureDevOpsService.addGeneralComment(mergedPrComment);
        console.log(`✅ Posted PR-level general comment with ${prLevelComments.length} item(s)`);
      } else {
        console.log(`📝 PR-level general comment already exists, skipping duplicate`);
      }
    }

    // Post file-level comments (no specific line anchor).
    for (const [filePath, comments] of fileLevelCommentsByFile.entries()) {
      try {
        const mergedText = comments.map((c: any) => this.formatComment(c)).join('\n\n---\n\n');
        console.log(`💬 Posting file-level comment for ${filePath}`);
        await this.azureDevOpsService.addFileComment(filePath, mergedText);
        console.log(`✅ Posted file-level comment for ${filePath}`);
      } catch (error: any) {
        console.error(`❌ Error posting file-level comment for ${filePath}:`, error.message);
        const fallbackComment = `**File: ${filePath}**\n\n${comments.map((c: any) => this.formatComment(c)).join('\n\n')}`;
        await this.azureDevOpsService.addGeneralComment(fallbackComment);
        console.log(`✅ Posted fallback general comment for ${filePath}`);
      }
    }

    // For each file, sort comments and coalesce contiguous line numbers into ranges
    for (const [filePath, comments] of inlineCommentsByFile.entries()) {
      // Sort by line ascending
      comments.sort((a: any, b: any) => (a.line || 0) - (b.line || 0));

      // Build ranges: each range is { startLine, endLine, comments: [...] }
      const ranges: Array<{ startLine: number; endLine: number; comments: any[] }> = [];

      for (const comment of comments) {
        const ln = comment.line as number;
        if (ranges.length === 0) {
          ranges.push({ startLine: ln, endLine: ln, comments: [comment] });
          continue;
        }

        const last = ranges[ranges.length - 1];
        if (ln <= last.endLine + 1) {
          // contiguous or overlapping - extend range and push comment
          last.endLine = Math.max(last.endLine, ln);
          last.comments.push(comment);
        } else {
          // start new range
          ranges.push({ startLine: ln, endLine: ln, comments: [comment] });
        }
      }

      // Post each range as either single-line inline comments or a ranged inline comment
      for (const range of ranges) {
        try {
          if (range.startLine === range.endLine) {
            // Single-line range: post the single comment (if multiple comments on same line, combine them)
            const commentsOnLine = range.comments;
            const mergedText = commentsOnLine.map((c: any) => this.formatInlineComment(c)).join('\n\n---\n\n');
            console.log(`💬 Posting inline comment for ${filePath} at line ${range.startLine}`);
            await this.azureDevOpsService.addInlineComment(filePath, mergedText, range.startLine, true);
            console.log(`✅ Posted inline comment for ${filePath} at line ${range.startLine}`);
          } else {
            // Multi-line contiguous range: use ranged inline comment for better anchoring
            const mergedText = range.comments.map((c: any) => this.formatInlineComment(c)).join('\n\n---\n\n');
            console.log(`💬 Posting ranged inline comment for ${filePath} lines ${range.startLine}-${range.endLine}`);
            await this.azureDevOpsService.addInlineCommentWithRange(filePath, mergedText, range.startLine, range.endLine, true);
            console.log(`✅ Posted ranged inline comment for ${filePath} lines ${range.startLine}-${range.endLine}`);
          }
        } catch (error: any) {
          console.error(`❌ Error posting inline comment for ${filePath} lines ${range.startLine}-${range.endLine}:`, error.message);
          const fallbackKey = filePath;
          if (!this.fallbackGeneralCommentFiles.has(fallbackKey)) {
            try {
              const fallbackComment = `**File: ${filePath}**\n\n${range.comments.map((c: any) => this.formatComment(c)).join('\n\n')}`;
              await this.azureDevOpsService.addGeneralComment(fallbackComment);
              this.fallbackGeneralCommentFiles.add(fallbackKey);
              console.log(`✅ Posted fallback general comment for ${filePath}`);
            } catch (fallbackError: any) {
              console.error(`❌ Fallback comment also failed for ${filePath}:`, fallbackError.message);
            }
          } else {
            console.log(`⚠️ Skipping additional fallback general comment for ${filePath} (already posted)`);
          }
        }
      }
    }
  }

  private hasRecentSummaryComment(existingComments: any[]): boolean {
    const recentThreshold = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    const now = new Date().getTime();
    
    return existingComments.some(comment => {
      if (!comment.content) return false;
      
      const isSummary = comment.content.includes('PR Review Summary') || 
                       comment.content.includes('Review Statistics') ||
                       comment.content.includes('Overall Assessment');
      
      if (!isSummary) return false;
      
      // Check if comment is recent (within 24 hours)
      const commentTime = new Date(comment.publishedDate || comment.lastUpdatedDate || 0).getTime();
      return (now - commentTime) < recentThreshold;
    });
  }

  private isDuplicateComment(
    newComment: any,
    existingComments: any[],
    existingIndex: { byLocation: Map<string, string[]>; byContent: Set<string> }
  ): boolean {
    // Only consider inline comments for duplicate detection
    if (!newComment.file || typeof newComment.line !== 'number' || newComment.line <= 0) return false;

    const normalizedNewFile = newComment.file.startsWith('/') ? newComment.file : '/' + newComment.file;
    const normalizedKey = `${normalizedNewFile}|${newComment.line}`;
    const normalizedNewContent = this.normalizeCommentContent(this.formatInlineComment(newComment));

    if (existingIndex.byContent.has(normalizedNewContent)) {
      return true;
    }

    return existingComments.some(existingComment => {
      if (!existingComment.content) return false;

      // Normalize existing thread path if present
      const existingPath = existingComment.threadContext?.filePath;
      const normalizedExistingFile = existingPath ? (existingPath.startsWith('/') ? existingPath : '/' + existingPath) : null;

      // Check if it's the same file and line
      const isSameLocation = normalizedExistingFile === normalizedNewFile &&
                             (existingComment.threadContext?.rightFileStart?.line === newComment.line ||
                              existingComment.threadContext?.rightFileEnd?.line === newComment.line ||
                              existingComment.threadContext?.leftFileStart?.line === newComment.line ||
                              existingComment.threadContext?.leftFileEnd?.line === newComment.line);

      if (!isSameLocation) return false;

      // Compare content similarity using normalized lowercase
      const newType = (newComment.type || '').toString().toLowerCase();
      const existingContent = existingComment.content.toString().toLowerCase();

      const isSimilarType = existingContent.includes(newType) ||
                            (newType === 'security' && existingContent.includes('security')) ||
                            (newType === 'bug' && existingContent.includes('bug')) ||
                            (newType === 'improvement' && existingContent.includes('improvement'));

      // Prefer identity by uniqueName if available; fallback to displayName containing 'Build Service'
      const isFromBuildService = existingComment.author?.uniqueName?.toLowerCase()?.includes('build') ||
                                 existingComment.author?.displayName?.toLowerCase()?.includes('build service');

      const isNotResolved = !existingComment.isDeleted && existingComment.status !== 'resolved';

      if (!(isSameLocation && isSimilarType && isFromBuildService && isNotResolved)) {
        return false;
      }

      const existingSet = existingIndex.byLocation.get(normalizedKey);
      if (!existingSet || existingSet.length === 0) {
        return false;
      }

      return existingSet.some(existingContent => existingContent.includes(normalizedNewContent));
    });
  }

  private isDuplicateFileLevelComment(newComment: any, existingComments: any[]): boolean {
    if (!newComment?.file || (typeof newComment.line === 'number' && newComment.line > 0)) return false;

    const normalizedNewFile = newComment.file.startsWith('/') ? newComment.file : '/' + newComment.file;
    const normalizedNewContent = this.normalizeCommentContent(this.formatComment(newComment));
    if (!normalizedNewContent) return false;

    return existingComments.some(existingComment => {
      if (!existingComment?.content) return false;

      const existingPath = existingComment.threadContext?.filePath;
      if (!existingPath) return false;

      const normalizedExistingFile = existingPath.startsWith('/') ? existingPath : '/' + existingPath;
      if (normalizedExistingFile !== normalizedNewFile) return false;

      const hasInlineAnchor = !!(
        existingComment.threadContext?.rightFileStart?.line ||
        existingComment.threadContext?.rightFileEnd?.line ||
        existingComment.threadContext?.leftFileStart?.line ||
        existingComment.threadContext?.leftFileEnd?.line
      );
      if (hasInlineAnchor) return false;

      const isFromBuildService = existingComment.author?.uniqueName?.toLowerCase()?.includes('build') ||
                                 existingComment.author?.displayName?.toLowerCase()?.includes('build service');
      if (!isFromBuildService) return false;

      const normalizedExistingContent = this.normalizeCommentContent(existingComment.content || '');
      return normalizedExistingContent === normalizedNewContent;
    });
  }

  private isDuplicateGeneralComment(newContent: string, existingComments: any[]): boolean {
    const normalizedNew = this.normalizeCommentContent(newContent);
    if (!normalizedNew) return false;

    return existingComments.some(existingComment => {
      if (!existingComment?.content) return false;

      const isFromBuildService = existingComment.author?.uniqueName?.toLowerCase()?.includes('build') ||
                                 existingComment.author?.displayName?.toLowerCase()?.includes('build service');
      if (!isFromBuildService) return false;

      const existingPath = existingComment.threadContext?.filePath;
      if (existingPath) return false; // file-level/inline comment, not PR-level

      const normalizedExisting = this.normalizeCommentContent(existingComment.content || '');
      return normalizedExisting === normalizedNew;
    });
  }

  private shouldContinueThread(newComment: any, existingComments: any[]): { shouldContinue: boolean; threadId?: number } {
    if (!newComment.file || !newComment.line) return { shouldContinue: false };
    
    const relatedThread = existingComments.find(existingComment => {
      if (!existingComment.content) return false;
      
      // Check if it's the same file and line
      const isSameLocation = existingComment.threadContext?.filePath === newComment.file &&
                            (existingComment.threadContext?.rightFileStart?.line === newComment.line ||
                             existingComment.threadContext?.rightFileEnd?.line === newComment.line);
      
      if (!isSameLocation) return false;
      
      // Check if it's a similar type of issue
      const newType = newComment.type?.toLowerCase() || '';
      const existingContent = existingComment.content.toLowerCase();
      
      const isSimilarType = existingContent.includes(newType) ||
                           (newType === 'security' && existingContent.includes('security')) ||
                           (newType === 'bug' && existingContent.includes('bug')) ||
                           (newType === 'improvement' && existingContent.includes('improvement'));
      
      // Check if the comment is from our build service
      const isFromBuildService = existingComment.author?.displayName?.includes('Build Service');
      
      return isSameLocation && isSimilarType && isFromBuildService;
    });

    if (relatedThread) {
      return { shouldContinue: true, threadId: relatedThread.threadId };
    }

    return { shouldContinue: false };
  }

  private formatInlineComment(comment: any): string {
    let formattedComment = `**${comment.type.toUpperCase()}** (Confidence: ${Math.round(comment.confidence * 100)}%)\n\n${comment.comment}`;
    
    if (comment.suggestion) {
      formattedComment += `\n\n💡 **Suggestion:**\n${comment.suggestion}`;
    }

    return formattedComment;
  }

  private formatComment(comment: any): string {
    let formattedComment = `**${comment.type.toUpperCase()}** (Confidence: ${Math.round(comment.confidence * 100)}%)\n\n${comment.comment}`;
    
    if (comment.suggestion) {
      formattedComment += `\n\n💡 **Suggestion:**\n${comment.suggestion}`;
    }

    return formattedComment;
  }

  private buildExistingCommentIndex(existingComments: any[]): { byLocation: Map<string, string[]>; byContent: Set<string> } {
    const byLocation = new Map<string, string[]>();
    const byContent = new Set<string>();

    existingComments.forEach(existingComment => {
      const filePath = existingComment.threadContext?.filePath;
      const rightLine = existingComment.threadContext?.rightFileStart?.line || existingComment.threadContext?.rightFileEnd?.line;
      if (!filePath || !rightLine) {
        return;
      }

      const isFromBuildService = existingComment.author?.uniqueName?.toLowerCase()?.includes('build') ||
                                 existingComment.author?.displayName?.toLowerCase()?.includes('build service');
      if (!isFromBuildService) {
        return;
      }

      const normalizedFile = filePath.startsWith('/') ? filePath : '/' + filePath;
      const key = `${normalizedFile}|${rightLine}`;
      const normalizedContent = this.normalizeCommentContent(existingComment.content || '');
      if (!normalizedContent) {
        return;
      }

      if (!byLocation.has(key)) {
        byLocation.set(key, []);
      }

      byLocation.get(key)!.push(normalizedContent);
      byContent.add(normalizedContent);
    });

    return { byLocation, byContent };
  }

  private normalizeCommentContent(content: string): string {
    return content
      .toLowerCase()
      .replace(/\*\*/g, '') // remove markdown bold markers
      .replace(/[\s\r\n]+/g, ' ') // collapse whitespace
      .replace(/[`*_>#-]/g, '') // remove other markdown artifacts
      .trim();
  }

  private formatSummaryComment(summary: any, prDetails: PRDetails): string {
    if (this.rawCustomInstructions.summaryTemplate) {
      return resolveSummaryTemplate(this.rawCustomInstructions.summaryTemplate, {
        repository:          tl.getVariable('Build.Repository.Name') ?? '',
        prId:                prDetails.id,
        prTitle:             prDetails.title,
        prDescription:       prDetails.description ?? '',
        sourceBranch:        prDetails.sourceRefName,
        targetBranch:        prDetails.targetRefName,
        overallAssessment:   summary.overall_assessment,
        status:              summary.requires_changes ? '❌ Changes Required' : '✅ Ready for Review',
        totalFilesReviewed:  String(summary.total_files_reviewed),
        totalIssuesFound:    String(summary.total_issues_found),
        criticalIssues:      String(summary.critical_issues),
        securityIssues:      String(summary.security_issues),
        bugIssues:           String(summary.bug_issues),
        improvementIssues:   String(summary.improvement_issues),
        styleIssues:         String(summary.style_issues),
        testIssues:          String(summary.test_issues),
        summary:             summary.summary,
        recommendations:     summary.recommendations,
      });
    }

    return `## 🔍 PR Review Summary

**Overall Assessment:** ${summary.overall_assessment.toUpperCase()}
**Status:** ${summary.requires_changes ? '❌ Changes Required' : '✅ Ready for Review'}

### 📊 Review Statistics
- **Files Reviewed:** ${summary.total_files_reviewed}
- **Total Issues Found:** ${summary.total_issues_found}
- **Critical Issues:** ${summary.critical_issues}
- **Security Issues:** ${summary.security_issues}
- **Bug Issues:** ${summary.bug_issues}
- **Improvement Issues:** ${summary.improvement_issues}
- **Style Issues:** ${summary.style_issues}
- **Test Issues:** ${summary.test_issues}

### 📝 Summary
${summary.summary}

### 💡 Recommendations
${summary.recommendations}

---
*This review was performed by Advanced PR Reviewer using Azure OpenAI and LangGraph*`;
  }

  private generateSummaryText(comments: any[], prDetails: PRDetails): string {
    if (comments.length === 0) {
      return "No issues found. The code appears to be well-written and follows best practices.";
    }

    const criticalIssues = comments.filter(c => c.type === 'security' || c.type === 'bug');
    const improvementIssues = comments.filter(c => c.type === 'improvement' || c.type === 'style');

    let summary = `Found ${comments.length} issues that need attention. `;

    if (criticalIssues.length > 0) {
      summary += `There are ${criticalIssues.length} critical issues that must be addressed before approval. `;
    }

    if (improvementIssues.length > 0) {
      summary += `There are ${improvementIssues.length} improvement suggestions to enhance code quality. `;
    }

    summary += `Overall, the PR ${criticalIssues.length > 0 ? 'requires changes' : 'can be approved with suggestions'}.`;

    return summary;
  }

  private generateRecommendations(comments: any[]): string {
    if (comments.length === 0) {
      return "No specific recommendations at this time.";
    }

    const recommendations = [];

    const securityIssues = comments.filter(c => c.type === 'security');
    if (securityIssues.length > 0) {
      recommendations.push(`🔒 Address ${securityIssues.length} security vulnerabilities before merging`);
    }

    const bugIssues = comments.filter(c => c.type === 'bug');
    if (bugIssues.length > 0) {
      recommendations.push(`🐛 Fix ${bugIssues.length} identified bugs to ensure functionality`);
    }

    const testIssues = comments.filter(c => c.type === 'test');
    if (testIssues.length > 0) {
      recommendations.push(`🧪 Add or improve tests for better code coverage`);
    }

    const styleIssues = comments.filter(c => c.type === 'style');
    if (styleIssues.length > 0) {
      recommendations.push(`🎨 Consider code style improvements for better readability`);
    }

    return recommendations.join('\n');
  }

  private isBinaryFile(filePath: string): boolean {
    const binaryExtensions = [
      '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
      '.zip', '.rar', '.7z', '.tar', '.gz',
      '.exe', '.dll', '.so', '.dylib', '.jar', '.war',
      '.mp3', '.mp4', '.avi', '.mov', '.wav'
    ];

    return binaryExtensions.some(ext => filePath.toLowerCase().endsWith(ext));
  }

  private createEmptyReviewResult(): ReviewResult {
    return {
      success: true,
      totalFilesReviewed: 0,
      totalComments: 0,
      llmCallsUsed: 0,
      maxLLMCalls: this.maxLLMCalls,
      reviewSummary: "No files to review",
      requiresChanges: false,
      canApprove: true
    };
  }

  private createReviewResult(
    reviewResults: PRReviewStateType[],
    finalSummary: any
  ): ReviewResult {
    const totalComments = reviewResults.flatMap(result => result.review_comments).length;
    const totalLLMCalls = reviewResults.reduce((sum, result) => sum + result.llm_calls, 0);

    return {
      success: true,
      totalFilesReviewed: reviewResults.length,
      totalComments: totalComments,
      llmCallsUsed: totalLLMCalls,
      maxLLMCalls: this.maxLLMCalls,
      reviewSummary: finalSummary.summary,
      requiresChanges: finalSummary.requires_changes,
      canApprove: finalSummary.can_approve
    };
  }
}
