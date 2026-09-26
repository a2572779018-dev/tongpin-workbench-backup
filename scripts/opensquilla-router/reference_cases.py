"""Reference conversations for the OpenSquilla V4.2 router parity fixture.

Each session is replayed turn by turn exactly like OpenSquilla's gateway step
feeds its router: the current user text, up to four earlier user texts, the
previous assistant reply (+ its output token count) and the bounded routing
history of earlier routed turns.  ``routed: False`` turns are transcript-only
(for example a turn that was answered on another business tier).

The corpus mixes Chinese and English from trivial acknowledgements to hard
multi-step work, plus inputs that exercise Python/Rust text semantics the
TypeScript port must reproduce (Unicode whitespace, full-width digits, astral
characters, special-token lookalikes, CRLF, very long words and texts).
"""

from __future__ import annotations

import json
import sys

LONG_MEETING_ZH = (
    "会议纪要：本周产品例会讨论了三个议题。第一，新版任务看板的上线时间调整到下月中旬，"
    "原因是移动端适配和权限模型还需要两轮测试；第二，客服反馈的通知延迟问题，定位到消息队列"
    "消费者在高峰期积压，需要扩容并增加监控告警；第三，年度预算中云服务费用超支百分之十二，"
    "财务要求各团队提交成本优化方案。会上还确认了负责人和时间节点，并约定下周复盘。"
)

LONG_REPORT_EN = (
    "Quarterly engineering report. The platform team migrated 14 services to the new "
    "container runtime, reduced median deploy time from 18 to 7 minutes, and retired the "
    "legacy cron host. Reliability: two SEV-2 incidents, both traced to configuration drift "
    "between staging and production; a drift detector now runs nightly. Cost: compute spend "
    "fell 9% after rightsizing, while storage grew 21% because of log retention. Next quarter "
    "we plan to consolidate observability tooling, introduce canary analysis, and document "
    "ownership for every service in the catalog. "
)

PY_CODE = '''```python
import json
import os
from dataclasses import dataclass


@dataclass
class Order:
    id: str
    amount: float
    currency: str
    status: str = "pending"


def load_orders(path):
    with open(path) as f:
        rows = json.load(f)
    orders = []
    for row in rows:
        orders.append(Order(row["id"], float(row["amount"]), row.get("currency", "CNY")))
    return orders


def total_by_currency(orders):
    totals = {}
    for order in orders:
        if order.status == "cancelled":
            continue
        totals[order.currency] = totals.get(order.currency, 0) + order.amount
    return totals


def apply_discount(orders, rate):
    for order in orders:
        order.amount = order.amount * (1 - rate)
    return orders


def export_report(orders, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    totals = total_by_currency(orders)
    with open(os.path.join(out_dir, "report.json"), "w") as f:
        json.dump(totals, f, ensure_ascii=False, indent=2)
    return totals


if __name__ == "__main__":
    data = load_orders("orders.json")
    data = apply_discount(data, 0.1)
    print(export_report(data, "out"))
```'''

LOG_BLOCK = "\n".join(
    f"2026-09-2{d % 8} 1{d % 10}:{d * 7 % 60:02d}:{d * 13 % 60:02d} ERROR worker-{d % 5} job={1000 + d} "
    f"upstream timed out after 30000ms while reading response header from upstream"
    for d in range(1, 26)
) + "\n"

TRACEBACK = """Traceback (most recent call last):
  File "app.py", line 12, in <module>
    main()
  File "app.py", line 8, in main
    print(data["name"])
KeyError: 'name'"""


def single(case_id: str, text: str, **turn: object) -> dict:
    return {"id": case_id, "turns": [{"user": text, **turn}]}


def session(case_id: str, *turns: dict) -> dict:
    return {"id": case_id, "turns": list(turns)}


def turn(user: str, assistant: str | None = None, output_tokens: int | None = None,
         *, routed: bool = True, gap_s: float = 40.0, usage: dict | None = None) -> dict:
    value: dict = {"user": user, "routed": routed, "gap_s": gap_s}
    if assistant is not None:
        value["assistant"] = assistant
    if usage is not None:
        value["usage"] = usage
    elif output_tokens is not None:
        value["usage"] = {"output_tokens": output_tokens}
    return value


SINGLE = [
    # Trivial chat and acknowledgements.
    ("ack-zh-hello", "你好"),
    ("ack-zh-there", "在吗？"),
    ("ack-zh-thanks", "谢谢"),
    ("ack-zh-ok", "好的"),
    ("ack-zh-received", "收到"),
    ("ack-en-thanks", "thanks!"),
    ("ack-en-ok", "ok"),
    ("ack-en-hello", "Hello there"),
    ("ack-zh-morning-emoji", "早上好呀 😊"),
    ("ack-zh-no-thanks", "不用了，谢谢。"),
    ("ack-en-yes", "yes"),
    ("ack-emoji", "👍"),
    ("ack-zh-laugh", "哈哈哈"),
    ("ack-en-night", "good night"),
    ("ack-zh-thanks-work", "辛苦了"),
    # Short factual questions.
    ("fact-zh-capital", "中国的首都是哪里？"),
    ("fact-en-capital", "What is the capital of Australia?"),
    ("fact-zh-km", "1 公里等于多少米？"),
    ("fact-zh-light", "光速是多少"),
    ("fact-en-author", 'Who wrote "Pride and Prejudice"?'),
    ("fact-zh-weekday", "今天星期几？"),
    ("fact-zh-water", "水的化学式是什么"),
    ("fact-en-leap", "How many days are in a leap year?"),
    ("fact-zh-everest", "珠穆朗玛峰有多高？"),
    ("fact-en-http", "What does HTTP stand for?"),
    # Rewrites and translation.
    ("rewrite-zh-translate", "把这句话翻译成英文：我们下周一开会讨论新版本的发布计划。"),
    ("rewrite-en-translate", "Translate to Chinese: The meeting has been moved to Thursday afternoon."),
    ("rewrite-zh-polish", "帮我润色一下：这个功能很好用，大家都很喜欢，希望以后多出这种功能。"),
    ("rewrite-en-grammar", 'Fix the grammar: "He don\'t know nothing about it."'),
    ("rewrite-zh-formal", "把下面这段话改得更正式一些：老板，明天我请个假，家里有点事。"),
    ("rewrite-zh-summary", "用一句话总结：同频是公司内部的任务与协作工具，支持每日任务、审批和通知。"),
    ("rewrite-en-concise", "Rewrite this sentence to be more concise: \"In order to be able to finish the project on time, we need to make sure that everyone is aware of the deadlines.\""),
    ("rewrite-zh-title", "给这段文字起个标题：团队在两周内完成了移动端改版，用户留存提升了百分之八。"),
    # Explanations.
    ("explain-zh-closure", "解释一下什么是闭包"),
    ("explain-en-tcp", "How does the TCP three-way handshake work?"),
    ("explain-zh-sky", "为什么天空是蓝色的？"),
    ("explain-en-thread", "What is the difference between a process and a thread?"),
    ("explain-zh-rebase", "教我怎么用 git rebase"),
    ("explain-zh-consensus", "什么是区块链的共识机制？"),
    ("explain-en-bigo", "Explain Big-O notation with examples."),
    ("explain-zh-useeffect", "介绍一下 React 的 useEffect 用法"),
    ("explain-en-css", "How to center a div in CSS?"),
    ("explain-zh-https", "请说明一下 HTTPS 的工作原理"),
    # Writing.
    ("write-zh-leave", "写一封请假邮件，请假两天，理由是家里有事"),
    ("write-en-announce", "Write a short product announcement for our new dark mode feature."),
    ("write-zh-review", "帮我写一段年终总结的开头，大概200字"),
    ("write-en-decline", "Draft a polite reply declining a meeting invitation."),
    ("write-zh-poem", "写一首关于秋天的五言绝句"),
    ("write-zh-welcome", "给新员工写一份入职欢迎词"),
    ("write-en-linkedin", "Write a LinkedIn post about our team shipping version 2.0."),
    # Bounded coding.
    ("code-zh-quicksort", "用 Python 写一个快速排序"),
    ("code-en-debounce", "Write a JavaScript function that debounces another function."),
    ("code-zh-sql", "写一个 SQL，查询每个部门工资最高的员工"),
    ("code-zh-regex", "帮我写个正则表达式，匹配中国大陆的手机号"),
    ("code-en-bash", "Write a bash script that renames all .txt files to .md in a folder."),
    ("code-zh-lru", "用 TypeScript 实现一个简单的 LRU 缓存"),
    ("code-en-pandas", "How do I read a CSV file with pandas and compute the mean of a column?"),
    ("code-zh-palindrome", "实现一个函数判断字符串是否是回文"),
    ("code-en-go", 'Write a Go HTTP handler that returns JSON {"status":"ok"}.'),
    ("code-zh-dockerfile", "给我一个 Dockerfile 示例，运行 Node.js 应用"),
    # Debugging.
    ("debug-zh-traceback", f"我的 Python 程序报错了：\n```\n{TRACEBACK}\n```\n怎么修复？"),
    ("debug-zh-npm", "npm install 报错 EACCES permission denied，怎么办？"),
    ("debug-en-rerender", "My React component re-renders infinitely when I call setState inside useEffect. Why?"),
    ("debug-zh-502", "线上服务偶发 502，日志如下：\n2026-09-20 10:01:02 ERROR upstream timed out\n2026-09-20 10:01:05 ERROR upstream timed out\n2026-09-20 10:01:09 ERROR connect() failed\n帮我分析根因"),
    ("debug-en-segfault", "Segmentation fault when running my C program after adding a free() call. The crash happens in the second loop iteration; valgrind says invalid read of size 8. What is the root cause?"),
    ("debug-en-npe", "Java NullPointerException in production after deploy:\nException in thread \"main\" java.lang.NullPointerException\n    at com.acme.billing.InvoiceService.total(InvoiceService.java:42)\n    at com.acme.billing.Main.main(Main.java:10)\nHow do I fix it?"),
    ("debug-en-k8s", "Kubernetes pod stuck in CrashLoopBackOff, kubectl describe shows OOMKilled. How to debug?"),
    ("debug-zh-sql-slow", "为什么我的 SQL 查询在数据量大时特别慢？EXPLAIN 显示全表扫描"),
    ("debug-en-webpack", "The build failed with \"Module not found: Can't resolve 'fs'\" in webpack 5. Root cause?"),
    ("debug-zh-git", "git push 被拒绝：! [rejected] main -> main (non-fast-forward)，怎么处理？"),
    # Architecture and design.
    ("arch-zh-im", "帮我设计一个支持百万并发的即时通讯系统架构，包括消息存储、推送、离线同步和多端一致性"),
    ("arch-en-saas", "Design a multi-tenant SaaS architecture with data isolation, per-tenant rate limiting, and zero-downtime migrations."),
    ("arch-zh-microservice", "我们要把单体应用拆成微服务，请给出拆分策略、服务边界划分、数据迁移和回滚方案"),
    ("arch-en-eventsourcing", "Compare event sourcing vs. CRUD for an order management system, including trade-offs, failure modes, and migration path."),
    ("arch-zh-scheduler", "设计一个分布式任务调度系统，要求支持定时、依赖编排、失败重试和多机房容灾"),
    ("arch-en-monorepo", "We need to refactor our monorepo with 40 packages into a modular architecture; propose module boundaries, dependency rules and a phased plan."),
    ("arch-zh-risk", "为一个跨境支付平台设计风控架构，考虑实时规则引擎、机器学习模型和人工审核的协同"),
    ("arch-en-crdt", "Design the data model and API for a collaborative document editor with real-time sync (CRDT vs OT)."),
    # High-risk operations.
    ("risk-zh-delete", "帮我写一个脚本，删除生产数据库中三个月前的所有订单数据"),
    ("risk-en-rollback", "How do I roll back a failed production deployment on Kubernetes without losing customer data?"),
    ("risk-zh-legal", "客户合同里的违约责任条款怎么写比较稳妥？需要法务审核的要点有哪些"),
    ("risk-zh-mysql", "下周要做生产环境 MySQL 5.7 升级 8.0 的迁移，帮我列一个详细的迁移和回滚计划"),
    ("risk-en-drop", "Write a migration that drops the legacy users table and overwrites the email column in production."),
    ("risk-zh-finance", "财务报表里应收账款突然增加了30%，帮我分析可能的原因和需要核查的地方"),
    # Strict output formats.
    ("fmt-zh-json", "只返回JSON，不要解释：把\"张三，28岁，工程师\"转换成包含name、age、job字段的对象"),
    ("fmt-en-yaml", "Output a YAML config for a GitHub Actions workflow that runs tests on push. Only return YAML."),
    ("fmt-zh-csv", "按格式输出CSV：列出中国四大名著的书名、作者、朝代"),
    ("fmt-en-schema", "Return a JSON schema for a user profile with name, email, and optional phone."),
    ("fmt-zh-sql-only", "只返回 SQL，不要解释：建一张订单表"),
    ("fmt-en-json-only", 'Give me the answer in JSON only: {"sentiment": ...} for the text "I love this product"'),
    # Long context.
    ("long-zh-minutes", "请总结以下会议纪要，并列出待办事项：\n" + "\n".join([LONG_MEETING_ZH] * 44)),
    ("long-en-code-review", "Review this code for bugs and suggest improvements:\n" + PY_CODE),
    ("long-en-logs", "These logs keep repeating in production, what is going on?\n" + LOG_BLOCK),
    ("long-zh-files", "请帮我看看 src/app/main.py、src/app/utils/helpers.py 和 tests/test_main.py 之间的依赖关系，是否有循环导入"),
    ("long-en-report", "Summarize the key risks in this report:\n" + LONG_REPORT_EN * 9),
    ("long-zh-markdown", "整理成表格：\n| 模块 | 负责人 | 状态 |\n| --- | --- | --- |\n| 登录 | 张三 | 完成 |\n| 支付 | 李四 | 进行中 |\n\n- 风险一：支付回调偶发超时\n- 风险二：登录验证码短信成本上升\n1. 下周完成压测\n2. 月底前上线灰度"),
    # Research, comparison and planning.
    ("plan-zh-react-vue", "对比一下 React 和 Vue 在大型项目中的优缺点"),
    ("plan-en-db", "Compare PostgreSQL and MongoDB for an analytics workload."),
    ("plan-zh-competitors", "帮我做一个竞品分析：Notion、飞书文档、语雀"),
    ("plan-zh-roadmap", "制定一个三个月的前端学习路线图"),
    ("plan-en-launch", "Create a step-by-step plan to launch a mobile app in 6 weeks."),
    ("plan-zh-llm-prices", "调研一下国内主流的大模型API价格，并给出选型建议"),
    ("plan-en-rag", "Write a survey of recent approaches to retrieval-augmented generation."),
    ("plan-zh-okr", "给我们团队设计一个 OKR 评估流程"),
    # Math and reasoning.
    ("math-zh-pool", "一个水池有两个进水管，甲管单独注满需要6小时，乙管需要4小时，两管同时开多久注满？"),
    ("math-en-sqrt2", "Prove that the square root of 2 is irrational."),
    ("math-zh-weekday", "如果今天是星期三，100天后是星期几？"),
    ("math-en-batball", "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?"),
    ("math-zh-quadratic", "求解方程 x^2 - 5x + 6 = 0"),
    ("math-en-coins", "What's the expected number of coin flips to get two heads in a row? Explain step by step."),
    # Text-semantics edge cases.
    ("edge-question-mark", "?"),
    ("edge-zh-dots", "。。。"),
    ("edge-mixed", "hello 你好 mixed 中英文 text"),
    ("edge-accents", "café naïve résumé Crème brûlée — how do I pronounce these?"),
    ("edge-fullwidth", "ＡＢＣ　１２３　全角字符测试：请把这些转换成半角"),
    ("edge-crlf", "第一行\r\n第二行\r\n第三行：这些换行符有什么区别？"),
    ("edge-tabs", "name\tage\tcity\nAlice\t30\tParis\nBob\t25\tTokyo"),
    ("edge-url", "https://example.com/docs/guide?section=2#intro 这个网页讲了什么？"),
    ("edge-cjk-ext-b", "𠀀𠀁𠀂 这些生僻字怎么读？"),
    ("edge-emoji-burst", "🎉🎉🎉 我们上线啦！！！感谢大家的努力 🙌"),
    ("edge-quotes", "Explain the difference between \"quoted text\", 'single quotes' and `backticks` in shells."),
    ("edge-special-tokens", "What do [CLS], [SEP] and [MASK] mean in BERT? Also [UNK] and [PAD]."),
    ("edge-long-word", "Is this a valid identifier: " + "super" + "califragilistic" * 9 + "expialidocious?"),
    ("edge-caps", "WHY DOES MY APP CRASH WHEN I OPEN THE SETTINGS PAGE ON IOS 19?"),
    ("edge-numbers", "Round 3.14159265 to 2 decimals and format 1234567890 with thousands separators."),
    ("edge-digits-unicode", "日期 ٢٠٢٦-٠٩-٢٠ ١٠:٠١ 和 ２０２６－０９－２０ 应该怎么统一格式？"),
    ("edge-invisible", "zero​width﻿space and \x1cseparators\x1d in\x1etext\x1f?"),
    ("edge-cyrillic", "Переведи на английский: Русский текст и 中文 and English."),
    ("edge-japanese", "今日はいい天気ですね。散歩に行きませんか？"),
    ("edge-korean", "안녕하세요, 회의 일정을 알려 주세요."),
    ("edge-code-no-debug", "What does this print?\n```js\nconst xs = [1, 2, 3];\nconsole.log(xs.map(x => x * 2));\n```"),
    ("edge-shell", "$ ls -la\n$ du -sh node_modules\n这两个命令输出的是什么？"),
    ("edge-json-like", 'Parse this: {"key": "value", "count": 3} and tell me the keys.'),
    ("edge-yaml-like", "service_name: billing\nreplicas: 3\nimage: acme/billing:1.4.2\n这个配置有什么问题吗？"),
    ("edge-csv-like", "id,name,score\n1,alice,90\n2,bob,85\n求平均分"),
    ("edge-unicode-space", "line one line two\xa0with nbsp　and ideographic space"),
    ("edge-zwj", "👨‍👩‍👧 family emoji and 👍🏽 skin tone — how many code points?"),
    ("edge-question-dense", "为什么？为什么？到底为什么？？？"),
    ("edge-private-use", "Private use  and unassigned \U000e0000 chars."),
    ("edge-nul", "a\x00b\x07c?"),
    # More everyday and hard requests.
    ("ack-en-hi", "hi"),
    ("ack-en-sounds-good", "Sounds good."),
    ("ack-en-thanks-lot", "cool, thanks a lot!"),
    ("ack-zh-ok-hao", "行，就这么办"),
    ("write-zh-weekly", "帮我写一份周报模板，包含本周进展、问题和下周计划"),
    ("explain-zh-k8s", "解释一下 Kubernetes 的 Service 和 Ingress 有什么区别"),
    ("code-zh-go-counter", "用 Go 实现一个并发安全的计数器，并说明为什么安全"),
    ("explain-zh-quantum", "给我讲讲量子计算的基本原理，用高中生能听懂的话"),
    ("arch-zh-flash-sale", "设计一个电商秒杀系统，要防超卖、抗高并发，并说明库存扣减、限流和降级方案"),
    ("risk-zh-warehouse", "我们的数据仓库要从 Hive 迁移到 ClickHouse，给出分阶段迁移方案、回滚预案和对线上报表的影响评估"),
    ("code-zh-image-script", "写一个 Python 脚本批量压缩某个文件夹里的图片"),
    ("debug-zh-index-slow", "分析一下为什么这条 SQL 走了索引还是很慢：SELECT * FROM orders WHERE status = 'paid' ORDER BY created_at DESC LIMIT 20"),
    ("risk-en-pg-region", "Plan a zero-downtime migration of a 5TB PostgreSQL database to a new region while production traffic keeps running."),
    ("explain-en-raft", "Explain how Raft handles leader election and log replication, including what happens during network partitions."),
    ("review-zh-pr", "帮我 review 一下这个 PR：修改了 auth 模块的 token 刷新逻辑，担心并发刷新导致重复登录"),
    ("plan-en-hiring", "Help me plan interviews for a senior backend engineer: stages, questions and a scoring rubric."),
]

# Features only OpenSquilla's full usage schema can exercise (the gateway
# itself only forwards output_tokens; the parity target is the model code).
RICH_USAGE = [
    ("usage-rich-continue", "请继续",
     "上一部分我们讨论了系统架构的核心模块。能否提供更多关于部署环境的信息？我不确定你们是否使用 Kubernetes。",
     {"output_tokens": 812, "reasoning_tokens": 2048, "duration_ms": 18500, "cached_tokens": 900, "input_tokens": 3000}),
    ("usage-rich-refusal", "why not?",
     "I cannot help with that request. As an AI, I'm not sure it is appropriate.",
     {"output_tokens": 35, "reasoning_tokens": 0, "duration_ms": 900, "cached_tokens": 0, "input_tokens": 120}),
]

SESSIONS = [
    session(
        "s-casual-to-arch",
        turn("在吗", "在的，有什么可以帮你？", 12),
        turn("我们公司想做一个内部知识库", "好的，可以先明确使用场景、权限模型和内容来源。你们大概有多少文档？", 58),
        turn("大概十万篇文档，需要全文检索、权限隔离、和大模型问答，帮我设计整体架构和数据流，考虑多租户和容灾",
             "整体架构可以分为采集、存储、检索、问答四层……（此处省略约两千字的方案）", 1850),
        turn("好的谢谢", "不客气！", 6),
        turn("那检索层用 Elasticsearch 还是向量数据库？", "可以混合检索：关键词用 Elasticsearch，语义用向量库，再做重排。", 240),
    ),
    session(
        "s-coding-progression",
        turn("用 Python 写一个函数，统计文本里每个单词出现的次数", "```python\nfrom collections import Counter\n\ndef word_count(text):\n    return Counter(text.split())\n```", 90),
        turn("再帮我加上单元测试", "```python\ndef test_word_count():\n    assert word_count('a b a')['a'] == 2\n```", 70),
        turn(f"测试报错了：\n```\n{TRACEBACK}\n```", "这个 KeyError 说明字典里没有 name 键，可以用 data.get('name')。", 110),
        turn("能不能优化一下性能，文本有几个 GB", "可以按行流式读取并使用生成器，避免一次性载入内存。", 320),
        turn("ok", "👍", 2),
    ),
    session(
        "s-deep-chat",
        turn("今天天气不错", "是呀，适合出去走走。", 15),
        turn("你喜欢什么季节", "我没有个人喜好，不过很多人喜欢秋天。", 22),
        turn("为什么", "秋天气温适中、景色丰富。", 18),
        turn("那冬天呢", "冬天有雪景，也有人喜欢。", 16),
        turn("哈哈好吧", "😄", 3),
        turn("晚安", "晚安！", 4),
    ),
    session(
        "s-en-research-complaint",
        turn("Compare Kafka and Pulsar for a multi-region event streaming platform.", "Kafka offers a mature ecosystem... Pulsar separates compute and storage...", 980),
        turn("That's wrong, Pulsar does support geo-replication natively.", "You're right, Pulsar has built-in geo-replication...", 400),
        turn("thanks", "You're welcome!", 5),
    ),
    session(
        "s-zh-complaint",
        turn("帮我写一个 SQL 统计每月新增用户", "SELECT DATE_FORMAT(created_at, '%Y-%m') AS month, COUNT(*) FROM users GROUP BY month;", 60),
        turn("不对，你搞错了，我要的是去重后的新增用户", "抱歉，应使用 COUNT(DISTINCT user_id)……", 80),
        turn("还是不对", "我重新整理一下……", 90),
    ),
    session(
        "s-continuation-story",
        turn("写一个科幻短篇的开头，主角是一名月球基地的维修工", "月球背面的维修舱里，林远第三次检查了氧气阀……" * 12, 1400),
        turn("继续", "警报声在走廊里回荡……" * 12, 1500),
        turn("继续", "他终于明白，这不是故障……" * 10, 1300),
        turn("go on", "The corridor lights flickered..." * 10, 900),
    ),
    session(
        "s-high-risk-escalation",
        turn("怎么查看 MySQL 的表结构", "可以使用 DESC table_name 或 SHOW CREATE TABLE。", 40),
        turn("生产库有张表要删除，帮我写回滚方案", "删除前先做全量备份并确认依赖……", 500),
        turn("收到", "好的，执行前请再次确认备份可用。", 20),
    ),
    session(
        "s-transcript-only-context",
        turn("帮我分析一下这份季度财报的主要风险", "主要风险包括现金流、应收账款和汇率波动……", 1200, routed=False),
        turn("第二点展开说说", "应收账款周转天数上升，说明回款变慢……", 600, routed=False),
        turn("那怎么办", "可以收紧信用政策、加强催收并考虑保理。", 300),
    ),
    session(
        "s-long-assistant",
        turn("帮我写一份新员工培训手册的大纲", LONG_MEETING_ZH * 20, 3900),
        turn("把第三章改得更详细一点", "第三章：工作流程与工具……" * 30, 2600),
        turn("很好，就这样", "好的！", 4),
    ),
    session(
        "s-en-debug-session",
        turn("My Flask app returns 500 on POST /login", "Can you share the traceback from the server log?", 25),
        turn("Traceback (most recent call last):\n  File \"/srv/app/auth.py\", line 88, in login\n    user = db.query(User).filter_by(email=email).one()\nsqlalchemy.orm.exc.NoResultFound: No row was found for one()",
             "Use one_or_none() and return 401 when the user does not exist.", 150),
        turn("fixed, thanks! now how do I add rate limiting?", "You can use Flask-Limiter with a Redis backend...", 420),
        turn("and deploy it to production with zero downtime?", "Use a rolling deployment behind the load balancer...", 700),
    ),
    session(
        "s-gap-expired",
        turn("设计一个高可用的支付网关，要求支持多通道路由、对账和熔断", "支付网关可以分为接入层、路由层、通道适配层……", 2100),
        turn("谢谢", "不客气", 4, gap_s=900.0),
    ),
    session(
        "s-en-planning",
        turn("We are launching a B2B analytics product next quarter.", "Great — what is the target customer and the core metric?", 30),
        turn("Mid-size retailers; the core metric is weekly active dashboards.", "Then onboarding and data connectors will drive activation.", 60),
        turn("Draft a go-to-market plan with pricing tiers, channels and a 12-week timeline.", "Here is a 12-week plan: weeks 1-2 positioning...", 1500),
        turn("ok thanks", "You're welcome!", 5, gap_s=700.0),
    ),
    session(
        "s-zh-risk-complaint",
        turn("线上订单服务要改数据库表结构，加一个索引会不会锁表？", "在 MySQL 8.0 中可以使用 Online DDL……", 400),
        turn("你说错了，我们用的是 5.6", "抱歉，MySQL 5.6 对部分 DDL 也支持 INPLACE……", 380),
        turn("那给我一个在生产环境执行的安全步骤", "建议先在从库验证，再使用 pt-online-schema-change……", 900),
    ),
    session(
        "s-mixed-language",
        turn("帮我把 README 翻译成英文", "Sure, please paste the README content.", 12),
        turn("# 同频\n同频是公司内部的任务协作工具。\n## 功能\n- 每日任务\n- 审批\n- 桌面通知", "# Tongpin\nTongpin is an internal task collaboration tool...", 90),
        turn("perfect", "Glad it helps!", 5),
    ),
]


def build_cases() -> list[dict]:
    cases = [single(case_id, text) for case_id, text in SINGLE]
    for case_id, text, prev_assistant, usage in RICH_USAGE:
        cases.append(session(
            case_id,
            turn("前情提要", prev_assistant, routed=False, usage=usage),
            turn(text),
        ))
    cases.extend(SESSIONS)
    return cases


if __name__ == "__main__":
    json.dump(build_cases(), sys.stdout, ensure_ascii=False, indent=1)
