"""
修正標註類別對應：標註工具的類別順序跟模型不同
標註工具: 0=vegetables, 1=beef, 2=pork
模型期望: 0=pork, 1=vegetables, 2=beef

重新對應: 0→1, 1→2, 2→0
"""

import os
import glob

REMAP = {0: 1, 1: 2, 2: 0}

LABEL_DIRS = [
    os.path.join(os.path.dirname(__file__), "dataset", "labels", "train"),
    os.path.join(os.path.dirname(__file__), "dataset", "labels", "val"),
]

fixed = 0
for label_dir in LABEL_DIRS:
    for txt_path in glob.glob(os.path.join(label_dir, "*.txt")):
        lines = open(txt_path, "r").readlines()
        new_lines = []
        for line in lines:
            parts = line.strip().split()
            if not parts:
                continue
            old_cls = int(parts[0])
            new_cls = REMAP.get(old_cls, old_cls)
            parts[0] = str(new_cls)
            new_lines.append(" ".join(parts))
        with open(txt_path, "w") as f:
            f.write("\n".join(new_lines) + "\n")
        fixed += 1

print(f"已修正 {fixed} 個標註檔案")
print(f"對應: {REMAP}")
