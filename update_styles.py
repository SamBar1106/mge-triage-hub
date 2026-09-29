import re

with open('css/styles.css', 'r') as f:
    content = f.read()

# Replace root variables
root_replacement = """:root {
  --bg-color: rgb(18, 18, 20);
  --card-bg: rgba(255, 255, 255, 0.035);
  --card-border: rgba(255, 255, 255, 0.1);
  --text-primary: rgb(250, 250, 250);
  --text-secondary: rgb(161, 161, 170);
  --accent-blue: rgb(56, 189, 248);
  --accent-blue-grad-start: #38bdf8;
  --accent-blue-grad-end: #0284c7;
  --accent-red: rgb(248, 113, 113);
  --accent-orange: rgb(251, 146, 60);
  --accent-green: rgb(74, 222, 128);
  --border-color: rgba(255, 255, 255, 0.12);

  --header-bg: rgba(24, 24, 27, 0.98);
  --scrollbar-thumb: rgba(255, 255, 255, 0.2);
  --glass-bg: rgba(255, 255, 255, 0.05);
  --glass-bg-hover: rgba(255, 255, 255, 0.08);
  --glass-bg-active: rgba(255, 255, 255, 0.14);
  --glass-border: rgba(255, 255, 255, 0.18);
  --glass-highlight: rgba(255, 255, 255, 0.1);
  
  --badge-loading-bg: rgba(245, 158, 11, 0.2);
  --badge-loading-text: rgb(251, 191, 36);
  --badge-loading-border: rgba(245, 158, 11, 0.4);
  --badge-ready-bg: rgba(34, 197, 94, 0.2);
  --badge-ready-text: rgb(74, 222, 128);
  --badge-ready-border: rgba(34, 197, 94, 0.4);
  --badge-error-bg: rgba(239, 68, 68, 0.2);
  --badge-error-text: rgb(248, 113, 113);
  --badge-error-border: rgba(239, 68, 68, 0.4);
  
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}

@media (prefers-color-scheme: light) {
  :root {
    --bg-color: rgb(243, 244, 246);
    --card-bg: rgb(255, 255, 255);
    --card-border: rgba(0, 0, 0, 0.1);
    --text-primary: rgb(15, 23, 42);
    --text-secondary: rgb(100, 116, 139);
    --accent-blue: rgb(2, 132, 199);
    --accent-blue-grad-start: #0ea5e9;
    --accent-blue-grad-end: #0369a1;
    --accent-red: rgb(220, 38, 38);
    --accent-orange: rgb(234, 88, 12);
    --accent-green: rgb(22, 163, 74);
    --border-color: rgba(0, 0, 0, 0.1);

    --header-bg: rgba(255, 255, 255, 0.98);
    --scrollbar-thumb: rgba(0, 0, 0, 0.2);
    --glass-bg: rgba(0, 0, 0, 0.03);
    --glass-bg-hover: rgba(0, 0, 0, 0.06);
    --glass-bg-active: rgba(0, 0, 0, 0.09);
    --glass-border: rgba(0, 0, 0, 0.1);
    --glass-highlight: rgba(0, 0, 0, 0.05);

    --badge-loading-bg: rgba(245, 158, 11, 0.15);
    --badge-loading-text: rgb(180, 83, 9);
    --badge-loading-border: rgba(245, 158, 11, 0.3);
    --badge-ready-bg: rgba(34, 197, 94, 0.15);
    --badge-ready-text: rgb(21, 128, 61);
    --badge-ready-border: rgba(34, 197, 94, 0.3);
    --badge-error-bg: rgba(239, 68, 68, 0.15);
    --badge-error-text: rgb(185, 28, 28);
    --badge-error-border: rgba(239, 68, 68, 0.3);
  }
}
"""

content = re.sub(r':root\s*\{.*?\n\}', root_replacement, content, flags=re.DOTALL)

# Replace hardcoded values outside of root
# We need to skip the :root block, so we'll just apply these carefully.

replacements = [
    (r'rgba\(255,\s*255,\s*255,\s*0\.2\)', 'var(--scrollbar-thumb)'),
    (r'rgba\(24,\s*24,\s*27,\s*0\.98\)', 'var(--header-bg)'),
    (r'rgba\(255,\s*255,\s*255,\s*0\.18\)', 'var(--glass-border)'),
    (r'rgba\(255,\s*255,\s*255,\s*0\.08\)', 'var(--glass-bg-hover)'),
    (r'rgba\(255,\s*255,\s*255,\s*0\.14\)', 'var(--glass-bg-active)'),
    (r'rgba\(255,\s*255,\s*255,\s*0\.05\)', 'var(--glass-bg)'),
    (r'rgba\(255,\s*255,\s*255,\s*0\.1\)', 'var(--glass-highlight)'),
]

# We need to only replace outside of the root block.
parts = content.split('@media (prefers-color-scheme: light) {')
part_1 = parts[0]
part_2 = '@media (prefers-color-scheme: light) {' + parts[1]

# Actually, the :root replacements shouldn't match anything since they are already changed in part_1, 
# but let's just replace in the whole file and then put the root block back if needed.
# Better:

with open('css/styles.css', 'r') as f:
    orig = f.read()

# First replace root
orig = re.sub(r':root\s*\{.*?\n\}', root_replacement, orig, flags=re.DOTALL)

# Then do general replacements, but only on lines that don't start with --
lines = orig.split('\n')
new_lines = []
for line in lines:
    if line.strip().startswith('--') or line.strip().startswith('@media') or line.strip().startswith(':root'):
        new_lines.append(line)
        continue
    
    for old, new in replacements:
        line = re.sub(old, new, line)
        
    new_lines.append(line)

content = '\n'.join(new_lines)

# Replace badges
content = content.replace('.badge-loading { background-color: rgba(245, 158, 11, 0.2); color: rgb(251, 191, 36); border: 1px solid rgba(245, 158, 11, 0.4); }', '.badge-loading { background-color: var(--badge-loading-bg); color: var(--badge-loading-text); border: 1px solid var(--badge-loading-border); }')
content = content.replace('.badge-ready { background-color: rgba(34, 197, 94, 0.2); color: rgb(74, 222, 128); border: 1px solid rgba(34, 197, 94, 0.4); }', '.badge-ready { background-color: var(--badge-ready-bg); color: var(--badge-ready-text); border: 1px solid var(--badge-ready-border); }')
content = content.replace('.badge-error { background-color: rgba(239, 68, 68, 0.2); color: rgb(248, 113, 113); border: 1px solid rgba(239, 68, 68, 0.4); }', '.badge-error { background-color: var(--badge-error-bg); color: var(--badge-error-text); border: 1px solid var(--badge-error-border); }')

# Replace hardcoded text colors
content = re.sub(r'color:\s*rgb\(250,\s*250,\s*250\);', 'color: var(--text-primary);', content)

with open('css/styles.css', 'w') as f:
    f.write(content)

