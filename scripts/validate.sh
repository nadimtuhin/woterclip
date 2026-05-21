#!/bin/bash
set -e

echo "=== WoterClip Validation ==="

# Check 1: YAML syntax — all YAML files parse cleanly
echo "--- Check 1: YAML syntax ---"
find . -name "*.yaml" -not -path "./.git/*" | xargs -I{} python3 -c "import yaml,sys; yaml.safe_load(open('{}'))" && echo "YAML OK"

# Check 2: Frontmatter required fields — all SKILL.md have name + description
echo "--- Check 2: Skill frontmatter ---"
python3 -c "
import os, re, sys
errors = []
for root, dirs, files in os.walk('skills'):
    if 'SKILL.md' in files:
        content = open(os.path.join(root,'SKILL.md')).read()
        fm = re.search(r'^---\n(.*?)\n---', content, re.DOTALL)
        if not fm or 'name:' not in fm.group(1) or 'description:' not in fm.group(1):
            errors.append(os.path.join(root,'SKILL.md'))
if errors: print('Missing frontmatter:', errors); sys.exit(1)
else: print('Skill frontmatter OK')
"

# Check 3: Frontmatter — all commands/*.md have description
echo "--- Check 3: Command frontmatter ---"
python3 -c "
import os, re, sys, glob
errors = []
for f in glob.glob('commands/*.md'):
    content = open(f).read()
    fm = re.search(r'^---\n(.*?)\n---', content, re.DOTALL)
    if not fm or 'description:' not in fm.group(1): errors.append(f)
if errors: print('Missing description:', errors); sys.exit(1)
else: print('Command frontmatter OK')
"

# Check 4: File references — check \${CLAUDE_PLUGIN_ROOT}/references/* paths resolve
echo "--- Check 4: File references ---"
python3 -c "
import os, re, glob, sys
errors = []
for f in glob.glob('skills/**/*.md', recursive=True) + glob.glob('commands/*.md'):
    content = open(f).read()
    refs = re.findall(r'\$\{CLAUDE_PLUGIN_ROOT\}/([^\s)\"]+)', content)
    for ref in refs:
        # Strip trailing slash if present
        ref = ref.rstrip('/')
        # Strip backtick if present
        ref = ref.rstrip('\`')
        if ref and not os.path.exists(ref): errors.append((f, ref))
if errors: [print(f'  {f}: missing {r}') for f,r in errors]; sys.exit(1)
else: print('File references OK')
"

# Check 5: SQLite DDL smoke test — run schema in temp DB, verify tables
echo "--- Check 5: SQLite DDL smoke test ---"
python3 -c "
import sqlite3, re, sys
ddl = open('references/backend-sqlite.md').read()
match = re.search(r'\`\`\`sql\n(.*?)\n\`\`\`', ddl, re.DOTALL)
if not match:
    print('No SQL block found'); sys.exit(1)
sql_text = match.group(1)
# Extract statements: PRAGMA (single line) and CREATE (multi-line until semicolon)
statements = []
current = []
for line in sql_text.split('\n'):
    current.append(line)
    if line.strip().endswith(';'):
        stmt = '\n'.join(current).strip()
        if stmt.startswith('PRAGMA') or stmt.startswith('CREATE'):
            statements.append(stmt)
        current = []
sql = ';\n'.join(statements) + ';'
conn = sqlite3.connect(':memory:')
conn.executescript(sql)
tables = [r[0] for r in conn.execute(\"SELECT name FROM sqlite_master WHERE type='table'\")]
assert 'issues' in tables and 'comments' in tables, f'Missing tables: {tables}'
print('SQLite DDL OK — tables:', tables)
"

# Check 6: Config template — version field is 2, backend field present
echo "--- Check 6: Config template ---"
python3 -c "
import yaml, sys
c = yaml.safe_load(open('templates/config.yaml'))
assert c.get('version') == 2, f'Expected version 2, got {c.get(\"version\")}'
assert 'backend' in c, 'Missing backend field'
print('Config template OK — version:', c['version'], 'backend:', c['backend'])
"

# Optional: Run pytest if tests exist
echo "--- SQL unit tests ---"
if [ -f "tests/test_sqlite_adapter.py" ]; then
    python3 -m pytest tests/test_sqlite_adapter.py -v
else
    echo "tests/test_sqlite_adapter.py not found, skipping"
fi

echo "=== All checks passed ==="
