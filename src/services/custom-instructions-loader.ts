import * as fs from 'fs';
import * as path from 'path';

export interface CustomInstructions {
  contextPrompt?: string;
  reviewPrompt?: string;
  securityPrompt?: string;
  suggestionsPrompt?: string;
  finalizationPrompt?: string;
  summaryTemplate?: string;
  // Injectable rules — merged into each prompt without replacing it
  contextRules?: string;
  reviewRules?: string;
  securityRules?: string;
  suggestionsRules?: string;
  finalizationRules?: string;
}

export interface SummaryPlaceholderContext extends PRPlaceholderContext {
  overallAssessment: string;
  status: string;
  totalFilesReviewed: string;
  totalIssuesFound: string;
  criticalIssues: string;
  securityIssues: string;
  bugIssues: string;
  improvementIssues: string;
  styleIssues: string;
  testIssues: string;
  summary: string;
  recommendations: string;
}

export interface PRPlaceholderContext {
  repository: string;
  prId: string | number;
  prTitle: string;
  prDescription: string;
  sourceBranch: string;
  targetBranch: string;
}

export interface ReviewPlaceholderContext extends PRPlaceholderContext {
  fileName: string;
  changedLines: string;
  diff: string;
  lineContext: string;
  expandedContext: string;
  externalContext: string;
  customRules?: string;
}

export interface ContextPlaceholderContext extends PRPlaceholderContext {
  changedFiles: string;
  externalContext: string;
  customRules?: string;
}

export interface SuggestionsPlaceholderContext extends PRPlaceholderContext {
  reviewComments: string;
  customRules?: string;
}

export interface FinalizationPlaceholderContext extends PRPlaceholderContext {
  reviewComments: string;
  totalIssues: string;
  llmCallsUsed: string;
  maxLlmCalls: string;
  customRules?: string;
}

function replace(content: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (acc, [key, value]) => acc.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value),
    content
  );
}

export function resolveReviewPrompt(template: string, ctx: ReviewPlaceholderContext): string {
  return replace(template, {
    repository:       ctx.repository,
    pr_id:            String(ctx.prId),
    pr_title:         ctx.prTitle,
    pr_description:   ctx.prDescription,
    source_branch:    ctx.sourceBranch,
    target_branch:    ctx.targetBranch,
    file_name:        ctx.fileName,
    changed_lines:    ctx.changedLines,
    diff:             ctx.diff,
    line_context:     ctx.lineContext,
    expanded_context: ctx.expandedContext,
    external_context: ctx.externalContext,
    custom_rules:     ctx.customRules ?? '',
  });
}

export function resolveContextPrompt(template: string, ctx: ContextPlaceholderContext): string {
  return replace(template, {
    repository:       ctx.repository,
    pr_id:            String(ctx.prId),
    pr_title:         ctx.prTitle,
    pr_description:   ctx.prDescription,
    source_branch:    ctx.sourceBranch,
    target_branch:    ctx.targetBranch,
    changed_files:    ctx.changedFiles,
    external_context: ctx.externalContext,
    custom_rules:     ctx.customRules ?? '',
  });
}

export function resolveSuggestionsPrompt(template: string, ctx: SuggestionsPlaceholderContext): string {
  return replace(template, {
    repository:      ctx.repository,
    pr_id:           String(ctx.prId),
    pr_title:        ctx.prTitle,
    pr_description:  ctx.prDescription,
    source_branch:   ctx.sourceBranch,
    target_branch:   ctx.targetBranch,
    review_comments: ctx.reviewComments,
    custom_rules:    ctx.customRules ?? '',
  });
}

export function resolveFinalizationPrompt(template: string, ctx: FinalizationPlaceholderContext): string {
  return replace(template, {
    repository:      ctx.repository,
    pr_id:           String(ctx.prId),
    pr_title:        ctx.prTitle,
    pr_description:  ctx.prDescription,
    source_branch:   ctx.sourceBranch,
    target_branch:   ctx.targetBranch,
    review_comments: ctx.reviewComments,
    total_issues:    ctx.totalIssues,
    llm_calls_used:  ctx.llmCallsUsed,
    max_llm_calls:   ctx.maxLlmCalls,
    custom_rules:    ctx.customRules ?? '',
  });
}

export function resolveSummaryTemplate(template: string, ctx: SummaryPlaceholderContext): string {
  return replace(template, {
    repository:           ctx.repository,
    pr_id:                String(ctx.prId),
    pr_title:             ctx.prTitle,
    pr_description:       ctx.prDescription,
    source_branch:        ctx.sourceBranch,
    target_branch:        ctx.targetBranch,
    overall_assessment:   ctx.overallAssessment,
    status:               ctx.status,
    total_files_reviewed: ctx.totalFilesReviewed,
    total_issues_found:   ctx.totalIssuesFound,
    critical_issues:      ctx.criticalIssues,
    security_issues:      ctx.securityIssues,
    bug_issues:           ctx.bugIssues,
    improvement_issues:   ctx.improvementIssues,
    style_issues:         ctx.styleIssues,
    test_issues:          ctx.testIssues,
    summary:              ctx.summary,
    recommendations:      ctx.recommendations,
  });
}

/**
 * Reads custom prompt template files from the .pr-review folder.
 * Called ONCE at startup — returns raw templates (placeholders not yet resolved).
 */
export function loadCustomInstructions(sourcesDir: string, folder: string = '.pr-review'): CustomInstructions {
  const basePath = path.join(sourcesDir, folder);
  const result: CustomInstructions = {};

  const readFile = (filename: string): string | undefined => {
    const filePath = path.join(basePath, filename);
    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8').trim();
        if (content) {
          console.log(`📄 Loaded custom prompt template: ${path.join(folder, filename)}`);
          return content;
        }
      }
    } catch {
      // Silent — missing or unreadable files are ignored
    }
    return undefined;
  };

  const readPrompt   = (filename: string) => readFile(path.join('prompts', filename));
  const readTemplate = (filename: string) => readFile(path.join('templates', filename));
  const readRule     = (filename: string) => readFile(path.join('rules', filename));

  result.contextPrompt      = readPrompt('context-prompt.md');
  result.reviewPrompt       = readPrompt('review-prompt.md');
  result.securityPrompt     = readPrompt('security-prompt.md');
  result.suggestionsPrompt  = readPrompt('suggestions-prompt.md');
  result.finalizationPrompt = readPrompt('finalization-prompt.md');
  result.summaryTemplate    = readTemplate('summary-template.md');

  result.contextRules      = readRule('context-rules.md');
  result.reviewRules       = readRule('review-rules.md');
  result.securityRules     = readRule('security-rules.md');
  result.suggestionsRules  = readRule('suggestions-rules.md');
  result.finalizationRules = readRule('finalization-rules.md');

  return result;
}
