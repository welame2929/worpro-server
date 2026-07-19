#!/usr/bin/env node
// 課題文チェックツール（JIKAGAMI 課題文作成支援）
//
// 練習会用オリジナル課題文の作成要件のうち、機械的に検証できる項目を自動チェックする。
//   1. 3500字以上あるか
//   2. 常用漢字表（＝小中学校で習う漢字の範囲）に含まれない漢字（表外字）がないか
//   3. 半角文字（数字・記号含む）が混入していないか
// 「語彙が中学生に分かるレベルか」は機械判定できないため対象外。生成時のAIプロンプトや
// 人手レビューで別途確認すること。
//
// 使い方: node tools/check-text.js <チェックするtxtファイル> [...複数可]
//        node tools/check-text.js --fix <チェックするtxtファイル>
//          半角英数字・記号・半角スペースを全角に自動変換した <元ファイル名>.fixed.txt を書き出す。
//          （半角カタカナの変換や表外字の言い換えは対象外。手直し後に再チェックすること）

const fs = require('fs');
const path = require('path');

const MIN_CHARS = 3500;
const JOYO_LIST_PATH = path.join(__dirname, 'joyo-kanji.txt');

function loadJoyoSet() {
  const raw = fs.readFileSync(JOYO_LIST_PATH, 'utf8');
  return new Set(raw.split(/\r?\n/).filter(l => l.length > 0));
}

function isKanji(ch) {
  const cp = ch.codePointAt(0);
  return (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0x3400 && cp <= 0x4DBF);
}

// 半角英数字・半角記号・半角スペース・半角カタカナをまとめて「半角文字」とみなす
function isHalfWidth(ch) {
  const cp = ch.codePointAt(0);
  return (cp >= 0x0020 && cp <= 0x007E) || (cp >= 0xFF61 && cp <= 0xFF9F);
}

// 半角ASCII（記号・数字・英字・スペース）を対応する全角文字へ変換する。
// 全角と半角ASCIIはU+FEE0だけコードポイントがずれているため単純な加算で変換できる
// （半角スペース0x20だけ全角スペースU+3000への対応が加算式に乗らないため個別対応）。
function toFullWidthAscii(text) {
  return [...text].map(ch => {
    const cp = ch.codePointAt(0);
    if (cp === 0x20) return '　';
    if (cp >= 0x21 && cp <= 0x7E) return String.fromCodePoint(cp + 0xFEE0);
    return ch;
  }).join('');
}

function checkText(filePath, joyoSet) {
  const text = fs.readFileSync(filePath, 'utf8');
  const totalChars = [...text.replace(/\n/g, '')].length;

  const kanjiViolations = new Map(); // 表外字 -> {count, lines:Set}
  const halfWidthViolations = [];

  let line = 1;
  for (const ch of text) {
    if (ch === '\n') { line++; continue; }
    if (isKanji(ch) && !joyoSet.has(ch)) {
      const rec = kanjiViolations.get(ch) || { count: 0, lines: new Set() };
      rec.count++;
      rec.lines.add(line);
      kanjiViolations.set(ch, rec);
    }
    if (isHalfWidth(ch)) {
      halfWidthViolations.push({ char: ch, line });
    }
  }

  const ok = totalChars >= MIN_CHARS && kanjiViolations.size === 0 && halfWidthViolations.length === 0;

  console.log(`\n=== ${filePath} ===`);
  console.log(`総字数（改行除く）: ${totalChars}字` +
    (totalChars >= MIN_CHARS ? '  OK' : `  NG（${MIN_CHARS}字まであと${MIN_CHARS - totalChars}字）`));

  console.log(`常用漢字表外の漢字: ${kanjiViolations.size}種`);
  for (const [ch, rec] of kanjiViolations) {
    console.log(`  ・「${ch}」 ${rec.count}回  行: ${[...rec.lines].join(',')}`);
  }

  console.log(`半角文字: ${halfWidthViolations.length}件`);
  const shown = halfWidthViolations.slice(0, 30);
  for (const v of shown) console.log(`  ・${v.line}行目 「${v.char}」`);
  if (halfWidthViolations.length > shown.length) {
    console.log(`  ...ほか${halfWidthViolations.length - shown.length}件`);
  }

  console.log(ok ? '=> 機械チェック: 合格（語彙レベルは別途目視確認）' : '=> 機械チェック: 要修正');
  return ok;
}

function main() {
  const args = process.argv.slice(2);
  const fixMode = args.includes('--fix');
  const targets = args.filter(a => a !== '--fix');
  if (targets.length === 0) {
    console.error('使い方: node tools/check-text.js [--fix] <チェックするtxtファイル> [...複数可]');
    process.exit(1);
  }

  if (fixMode) {
    for (const t of targets) {
      const text = fs.readFileSync(t, 'utf8');
      const fixed = toFullWidthAscii(text);
      const outPath = t.replace(/\.txt$/i, '') + '.fixed.txt';
      fs.writeFileSync(outPath, fixed, 'utf8');
      console.log(`半角→全角変換したファイルを書き出しました: ${outPath}`);
    }
    return;
  }

  const joyoSet = loadJoyoSet();
  let allOk = true;
  for (const t of targets) {
    const ok = checkText(t, joyoSet);
    allOk = allOk && ok;
  }
  process.exitCode = allOk ? 0 : 1;
}

main();
