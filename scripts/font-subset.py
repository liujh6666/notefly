# -*- coding: utf-8 -*-
"""
字体子集化助手：把全量 woff2 裁成「常用字符集」版本。

用法：
    python scripts/font-subset.py <输入.woff2> <输出.woff2> <码位文件.txt>

码位文件每行一个十六进制码位（不带 U+ 前缀），由 scripts/fetch-puhuiti.js 生成。
依赖：fonttools + brotli（pip install fonttools brotli）
"""
import sys

from fontTools import subset


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(2)

    src, dst, unicodes_file = sys.argv[1], sys.argv[2], sys.argv[3]

    args = [
        src,
        "--output-file=" + dst,
        "--unicodes-file=" + unicodes_file,
        "--flavor=woff2",
        "--layout-features=*",
        "--no-hinting",
        "--desubroutinize",
        "--drop-tables+=DSIG",
        "--name-IDs=*",
        "--notdef-outline",
        "--recalc-bounds",
        "--recalc-timestamp",
    ]
    subset.main(args)


if __name__ == "__main__":
    main()
