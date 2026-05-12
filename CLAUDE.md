# ProxyMiner Agent Guardrails

ProxyMiner fixtures include minified SEC HTML where a single line can be
multiple megabytes. Do not use raw `grep`, `cat`, `awk`, or `sed` against
`.fixtures/**/source.html` or large fixture JSON. Those commands can emit an
entire filing into the agent transcript and have previously contributed to
server OOM kills.

Use bounded probes instead:

```bash
npm run probe:fixture -- --company crm --filing 000110852425000009 --pattern "CEO Pay Ratio"
npm run probe:fixture -- --file .fixtures/by-filing/meta/000132680125000040/source.html --pattern "Advisory Vote"
```

If shell inspection is unavoidable, cap producer output before it reaches the
agent transport, for example `head -c 2000`, `dd bs=1 count=2000`, or a script
that prints fixed-size snippets. Avoid broad recursive searches over
`.fixtures`, `.next`, `node_modules`, and `.claude`.
