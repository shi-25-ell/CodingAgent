const expected = [
  "@coding-agent/model",
  "@coding-agent/model/testing",
  "@coding-agent/agent",
  "@coding-agent/agent/session",
  "@coding-agent/agent/context",
  "@coding-agent/agent/testing",
  "@coding-agent/coding",
  "@coding-agent/coding/print",
  "@coding-agent/coding/testing",
];

for (const specifier of expected) await import(specifier);
console.log(`Resolved ${expected.length} declared package export paths.`);
