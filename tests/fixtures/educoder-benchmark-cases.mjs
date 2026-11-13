// 原创测试题。公开样例进入题面，隐藏用例只在 QuickJS 判题器中使用。
const main = 'src/main.js';

function assignment(id, title, name, parameters, description, cases, extra = {}) {
  return {
    id,
    title,
    name,
    cases,
    instructions: [
      '在 Node.js 风格的 CommonJS 文件中完成 JavaScript 函数 `' + name + '(' + parameters + ')`。',
      '请保留函数导出。评测会直接调用该函数，不读取控制台。返回值需与示例的类型一致。',
      description,
      extra.instructions,
      '公开示例：',
      ...cases.slice(0, 2).map(([args, output]) =>
        name + '(' + args.map(value => JSON.stringify(value)).join(', ') + ') → ' + JSON.stringify(output)),
    ].filter(Boolean).join('\n'),
    files: {
      [main]: 'function ' + name + '(' + parameters + ') {\n  // TODO\n  return null;\n}\n\nmodule.exports = { ' + name + ' };\n',
      ...extra.files,
    },
  };
}

export const benchmarkCases = [
  assignment('merge-intervals', '合并闭区间', 'mergeIntervals', 'intervals',
    '输入为无序整数闭区间，每个起点小于或等于终点。合并重叠区间（端点相同也合并），按起点升序返回。相邻但不重叠的整数区间保持独立。', [
      [[[[1, 3], [2, 4], [7, 9]]], [[1, 4], [7, 9]]],
      [[[[5, 6], [1, 5]]], [[1, 6]]],
      [[[]], []],
      [[[[2, 2], [1, 1], [-2, 0], [-4, -2]]], [[-4, 0], [1, 1], [2, 2]]],
      [[[[8, 10], [2, 7], [4, 5], [7, 8], [1, 1], [2, 7]]], [[1, 1], [2, 10]]],
      [[[[2, 3], [0, 0], [5, 5], [4, 4]]], [[0, 0], [2, 3], [4, 4], [5, 5]]],
    ]),
  assignment('quoted-csv', '解析一行 CSV', 'parseCsvLine', 'line',
    '解析一条 CSV 记录，返回字符串数组。未加引号的字段保留原样；双引号包住的字段可含逗号，内部两个连续双引号表示一个双引号。输入均合法，空字符串表示一个空字段，末尾逗号表示一个额外空字段。', [
      [['a,"b,c",d'], ['a', 'b,c', 'd']],
      [['"a""b",'], ['a"b', '']],
      [[''], ['']],
      [['"",,,""""'], ['', '', '', '"']],
      [['  x  ," , ",尾'], ['  x  ', ' , ', '尾']],
      [['"a","b""c","x,y",,end,'], ['a', 'b"c', 'x,y', '', 'end', '']],
    ]),
  assignment('dependencies', '任务依赖排序', 'scheduleTasks', 'tasks, edges',
    'tasks 为唯一的小写英文标识符，edges 的每项为 [先执行, 后执行]，可能重复。返回字典序最小的合法拓扑序。任意时刻从所有当前可执行任务中选字典序最小者。有环返回 null。', [
      [[['a', 'b', 'c'], [['b', 'a']]], ['b', 'a', 'c']],
      [[['a', 'b'], [['a', 'b'], ['b', 'a']]], null],
      [[[], []], []],
      [[['d', 'c', 'b', 'a', 'e'], [['a', 'c'], ['b', 'c'], ['c', 'd'], ['a', 'c']]], ['a', 'b', 'c', 'd', 'e']],
      [[['solo'], [['solo', 'solo']]], null],
      [[['q', 'b', 'x', 'aa', 'a'], [['q', 'aa'], ['x', 'b']]], ['a', 'q', 'aa', 'x', 'b']],
    ]),
  assignment('warehouse-ledger', '仓库流水汇总', 'inventory', 'events',
    '流水依序执行，每条为 [SKU, 有符号整数数量]，库存起始为零。若一条流水使对应库存变成负数，则忽略该流水。返回 [SKU, 剩余数量] 列表，只保留正库存，按 SKU 的 UTF-16 字典序排序。SKU 大小写敏感，可等于任意非空字符串。', [
      [[[['x', 3], ['y', 1], ['x', -2]]], [['x', 1], ['y', 1]]],
      [[[['x', -3], ['x', 2], ['x', -3]]], [['x', 2]]],
      [[[['b', 0], ['a', 2], ['a', -2]]], []],
      [[[['__proto__', 3], ['constructor', 2], ['x', -1], ['__proto__', -2]]], [['__proto__', 1], ['constructor', 2]]],
      [[[['b', 2], ['A', 3], ['a', 1], ['a', -2], ['b', -1]]], [['A', 3], ['a', 1], ['b', 1]]],
      [[[]], []],
    ]),
  assignment('unicode-window', 'Unicode 最长不重复子串', 'longestDistinct', 'value',
    '按 Unicode 码点处理字符串（代理对如 😀 是一个字符），不做 Unicode 规范化。返回最长的连续且码点互异的子串。长度相同则取起点最早的子串。', [
      [['abba'], 'ab'],
      [['😀a😀b'], 'a😀b'],
      [[''], ''],
      [['𐐀𐐁𐐀a𐐁b'], '𐐀a𐐁b'],
      [['e\u0301ée'], 'e\u0301é'],
      [['甲乙甲丙乙丁丙'], '甲丙乙丁'],
    ]),
  assignment('grid-path', '传送前的最短路径', 'shortestRoute', 'grid',
    'grid 为等长字符串行构成的矩形，含唯一 S 和 E，# 是墙，. 是可走区域。只能上下左右走，每步长度为 1。返回从 S 到 E 的最少步数，无法到达返回 -1。', [
      [[['S.E']], 2],
      [[['S#E']], -1],
      [[['S#..E', '.#.#.', '.....']], 8],
      [[['E.', '.S']], 2],
      [[['S..', '##.', 'E..']], 6],
      [[['S', '.', '#', 'E']], -1],
    ]),
  assignment('minor-units', '金额字符串转分', 'amountToMinor', 'text',
    '字符串由可选的前导减号、至少一位十进制整数、可选的点及 1–4 位小数组成。转换到整数分，第三位小数达到 5 时朝离零方向进位。返回十进制字符串，不留前导零和负零。整数部分可长达 60 位，不可损失精度。', [
      [['12.345'], '1235'],
      [['-0.0049'], '0'],
      [['-0.0050'], '-1'],
      [['000001.995'], '200'],
      [['99999999999999999999999999.995'], '10000000000000000000000000000'],
      [['-123456789012345678901234567890.9999'], '-12345678901234567890123456789100'],
    ]),
  assignment('lru-cache', '按操作序列模拟 LRU', 'cacheReads', 'capacity, operations',
    '缓存初始为空。操作为 ["put", key, value] 或 ["get", key]。每次 get 输出当前值，未命中输出 null。成功读取、插入和更新都会使该键成为最近使用者。容量不足时淘汰最久未使用的键。容量可以为 0，key 为字符串，value 为整数。返回 get 的结果数组。', [
      [[2, [['put', 'a', 1], ['get', 'a'], ['get', 'b']]], [1, null]],
      [[0, [['put', 'a', 1], ['get', 'a']]], [null]],
      [[2, [['put', 'a', 1], ['put', 'b', 2], ['get', 'a'], ['put', 'c', 3], ['get', 'b'], ['get', 'a'], ['get', 'c']]], [1, null, 1, 3]],
      [[2, [['put', 'a', 1], ['put', 'b', 2], ['put', 'a', 9], ['put', 'c', 3], ['get', 'b'], ['get', 'a']]], [null, 9]],
      [[1, [['put', 'constructor', 0], ['get', 'constructor'], ['get', ''], ['put', '', -1], ['get', 'constructor'], ['get', '']]], [0, null, null, -1]],
      [[5, []], []],
    ]),
  assignment('segment-query', '区间更新与区间和', 'rangeQueries', 'values, operations',
    '每条操作为 ["add", l, r, delta] 或 ["sum", l, r]，l 和 r 为从 0 开始的下标，且闭区间有效。add 为该区间每项累加 delta；sum 把该区间元素和追加到结果数组。values 和 operations 各最多 100,000 项，需支持高效区间操作；所有计算都在 JavaScript 安全整数范围内。', [
      [[[1, 2, 3], [['sum', 0, 2], ['add', 1, 2, 5], ['sum', 1, 2]]], [6, 15]],
      [[[0], [['add', 0, 0, -7], ['sum', 0, 0]]], [-7]],
      [[[2, -2, 2, -2], [['add', 0, 3, 3], ['add', 1, 2, -6], ['sum', 0, 3], ['sum', 1, 1], ['sum', 2, 3]]], [0, -5, 0]],
      [[[], []], []],
      [[[1, 2, 3, 4, 5], [['add', 0, 0, 9], ['add', 4, 4, -9], ['sum', 0, 0], ['sum', 4, 4], ['sum', 0, 4]]], [10, -4, 15]],
      [[Array(24_000).fill(0), [...Array.from({ length: 24_000 }, () => ['add', 0, 23_999, 1]), ['sum', 0, 23_999], ['sum', 7, 7]]], [576_000_000, 24_000]],
    ]),
  assignment('expression', '整数表达式求值', 'evaluateExpression', 'source',
    '表达式由非负整数字面量、空格、括号、二元 + - * / 和一元 + - 构成，保证合法且不除以零。乘除优先于加减，同级二元运算左结合，一元运算优先于乘除，允许多个一元符号相连。每次除法独立朝零取整，中间值为 JavaScript 安全整数。', [
      [['2+3*4'], 14],
      [['-(8+1)/2'], -4],
      [['-(-2) * --3 + +4'], 10],
      [['20 / 3 * 3'], 18],
      [['1- -(-3) * +2'], -5],
      [[' ( 7 - 8 / -3 ) * -2 '], -18],
    ]),
  assignment('price-summary', '按 SKU 汇总订单', 'summarizeOrders', 'lines',
    '每条订单为 [SKU, 单价分, 数量]，单价和数量均为非负安全整数。返回非零订单汇总 [标准 SKU, 合计分]，按标准 SKU 的字典序升序排列。单行合计不足以处理重复 SKU 时应累加。输入输出的所有数值在安全整数范围。', [
      [[[[' blue ', 150, 2], ['BLUE', 100, 1], ['RED', 50, 2]]], [['BLUE', 400], ['RED', 100]]],
      [[[['a', 50, 0], [' b-c ', 9, 1]]], [['B-C', 9]]],
      [[[[' __proto__ ', 8, 1], ['a', 0, 1], ['__PROTO__', 7, 2]]], [['__PROTO__', 22]]],
      [[[[' é ', 7, 2], ['É', 5, 2], ['Z', 1, 1]]], [['Z', 1], ['É', 24]]],
      [[[['x', 9007199254740900, 1], ['X', 5, 1]]], [['X', 9007199254740905]]],
      [[[]], []],
    ], {
      instructions: '修改两个文件。src/sku.js 导出的 normalizeSku(value) 负责标准化（去掉两端空白、转大写）；src/main.js 必须使用 require("./sku.js") 获取并调用 normalizeSku。评测也单独调用辅助函数。',
      files: {
        'src/sku.js': 'function normalizeSku(value) {\n  // TODO\n  return value;\n}\n\nmodule.exports = { normalizeSku };\n',
      },
    }),
  assignment('meeting-summary', '会议时长汇总', 'summarizeMeetings', 'meetings',
    '每条记录为 [成员, 开始, 结束]。起止时间均为 24 小时制 HH:MM（00:00–23:59），允许跨午夜，起止相同表示 0 分钟。返回 [成员, 总分钟数]，成员按 UTF-16 字典序排序。保留出现过的全部成员。重叠会议分别计入时长。', [
      [[[['b', '23:50', '00:10'], ['a', '10:00', '10:30'], ['b', '08:00', '08:05']]], [['a', 30], ['b', 25]]],
      [[[['同学', '08:00', '08:00']]], [['同学', 0]]],
      [[[['x', '00:00', '23:59'], ['x', '23:59', '00:00']]], [['x', 1440]]],
      [[[['constructor', '01:20', '02:30'], ['__proto__', '22:00', '01:00']]], [['__proto__', 180], ['constructor', 70]]],
      [[[['x', '03:00', '03:30'], ['x', '03:05', '03:10'], ['A', '12:34', '12:34']]], [['A', 0], ['x', 35]]],
      [[[]], []],
    ], {
      instructions: '修改两个文件。src/time.js 导出的 toMinutes(value) 把 HH:MM 转为从午夜起算的整数分钟；src/main.js 必须使用 require("./time.js") 获取并调用 toMinutes。评测也单独调用辅助函数。',
      files: {
        'src/time.js': 'function toMinutes(value) {\n  // TODO\n  return 0;\n}\n\nmodule.exports = { toMinutes };\n',
      },
    }),
];

benchmarkCases.find(item => item.id === 'price-summary').auxiliary = {
  path: 'src/sku.js', name: 'normalizeSku', cases: [[['\télan '], 'ÉLAN'], [['mix-12'], 'MIX-12']],
};
benchmarkCases.find(item => item.id === 'meeting-summary').auxiliary = {
  path: 'src/time.js', name: 'toMinutes', cases: [[['00:01'], 1], [['23:59'], 1439]],
};
