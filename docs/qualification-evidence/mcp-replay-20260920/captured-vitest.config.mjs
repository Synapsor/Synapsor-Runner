export default {
  plugins: [{ name: 'captured-result-observation', enforce: 'pre', transform(code, id) {
    if (id.endsWith('/packages/mcp-server/src/semantic-actions.ts')) return `${code}\nexport { semanticProposalResult as capturedProposalResult };`;
  } }],
  test: { include: ['docs/qualification-evidence/mcp-replay-20260920/captured-result.qualification.ts'], maxWorkers: 1, minWorkers: 1 },
};
