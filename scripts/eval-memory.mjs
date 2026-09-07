// Synthetic recall/relevance probe, not an end-to-end coding benchmark.
// Usage: npm run eval:memory -- http://localhost:8080 qwen3.5-9b-q4 /tmp/memory-eval.json
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [endpoint = 'http://localhost:8080', model = 'local', output] = process.argv.slice(2);
let partialReport;
const temporary = await mkdtemp(join(tmpdir(), 'llh-memory-eval-'));
try {
  const bundle = join(temporary, 'eval.mjs');
  await build({ stdin: { contents: `
    export * from './src/chat/memory.ts';
    export { generateMemory } from './src/chat/memoryGeneration.ts';
    export { streamChat, tokenize, fetchServerContextSize } from './src/llm/client.ts';
    export { buildSystemPrompt } from './src/llm/prompt.ts';
    export { asOpenAiTools, toolsForMode } from './src/tools/toolDefinitions.ts';
  `, resolveDir: process.cwd() }, outfile: bundle, bundle: true, format: 'esm', platform: 'node' });
  const lib = await import(pathToFileURL(bundle).href);
  const limit = await lib.fetchServerContextSize(endpoint, model);
  if (!limit) throw new Error('Server context size unavailable');
  const record = {
    id: '123e4567-e89b-42d3-a456-426614174001', title: 'Atlas export and parser decisions', workspaceRoot: '/synthetic-atlas',
    messages: [
      { role: 'user', content: 'For Atlas CSV export, use the delimiter | (pipe) and exclude archived records by default. The parser cache key prefix is atlas_rev_7. Remember these decisions.', ts: 1 },
      { role: 'assistant', content: 'Recorded decisions: CSV delimiter is pipe; archived records are excluded by default; parser cache keys use atlas_rev_7. No code has been changed or tested.', ts: 2 }
    ]
  };
  const generationStarted = performance.now();
  const summary = await lib.generateMemory(record, endpoint, model, AbortSignal.timeout(120000));
  record.memory = { text: summary, sourceRevision: lib.transcriptRevision(record), generatedAt: Date.now(), enabled: true, manual: false };
  const generationMs = Math.round(performance.now() - generationStarted);
  const cases = [
    { id: 'recall-export', question: 'What delimiter did we decide to use for Atlas CSV export?', expected: /pipe|\|/i },
    { id: 'recall-parser', question: 'What exact parser cache key prefix did we decide to use in Atlas?', expected: /atlas_rev_7/ },
    { id: 'current-override', question: 'For this request, override the previous Atlas CSV delimiter decision: use a semicolon. What delimiter should you use now?', expected: /semicolon|;/i },
    { id: 'irrelevant', question: 'What is 17 plus 25?', expected: /\b42\b/ }
  ];
  const results = [];
  const report = { model, createdAt: new Date().toISOString(), generationMs, summary,
    summaryTokens: await lib.tokenize(endpoint, summary, model), results,
    limitation: 'One sequential sample per condition on synthetic facts; no coding-task accuracy or statistically reliable latency conclusion.' };
  partialReport = report;
  const saveReport = async () => { if (output) await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n'); };
  await saveReport();
  for (const test of cases) {
    for (const enabled of [false, true]) {
      const memories = enabled ? await lib.fitMemories(lib.rankMemories(test.question, [record], 'new'),
        Math.min(2048, Math.floor(limit * 0.05)), text => lib.tokenize(endpoint, text, model)) : [];
      const request = {
        model, temperature: 0, top_k: 40, top_p: 0.95, max_tokens: 256, thinking_budget_tokens: 0,
        chat_template_kwargs: { enable_thinking: false },
        messages: [
          { role: 'system', content: lib.buildSystemPrompt({ family: 'qwen3', mode: 'review', nativeTools: true, workspaceRoot: '/synthetic-atlas' }) + lib.renderMemories(memories) },
          { role: 'user', content: test.question + ' Answer directly in one sentence. Do not call tools. If the answer is not available in the conversation, say you do not know.' }
        ],
        tools: lib.asOpenAiTools(lib.toolsForMode('review', 'native')), parallel_tool_calls: false
      };
      let answer = '', promptTokens, completionTokens;
      let toolCalls = 0;
      const start = performance.now();
      let error;
      try {
      for await (const chunk of lib.streamChat(endpoint, request, AbortSignal.timeout(30000))) {
        if (chunk.kind === 'text') answer += chunk.text;
        if (chunk.kind === 'usage') { promptTokens = chunk.promptTokens; completionTokens = chunk.completionTokens; }
        if (chunk.kind === 'toolCall') toolCalls++;
      }
      } catch (failure) { error = failure.message; }
      const result = { error, case: test.id, memoryEnabled: enabled, selectedMemories: memories.length,
        correct: !error && test.expected.test(answer) && toolCalls === 0,
        irrelevantMemorySelected: test.id === 'irrelevant' && memories.length > 0,
        promptTokens, completionTokens, latencyMs: Math.round(performance.now() - start), answer, toolCalls };
      results.push(result);
      await saveReport();
      console.log(JSON.stringify(result));
    }
  }
  console.log(JSON.stringify({ summary, generationMs, summaryTokens: report.summaryTokens }));
} catch (error) {
  const report = { ...(partialReport ?? { model, createdAt: new Date().toISOString(), results: [] }), error: error.message };
  if (output) await writeFile(resolve(output), JSON.stringify(report, null, 2) + '\n');
  console.error(error.message);
  process.exitCode = 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
