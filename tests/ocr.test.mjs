import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTsv } from '../src/ocr.mjs';

test('OCR words group by page/block/paragraph/line and preserve screen coordinates', () => {
  const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n' +
    '5\t1\t1\t1\t1\t1\t10\t20\t40\t15\t97\tCLICK\n' +
    '5\t1\t1\t1\t1\t2\t55\t20\t20\t15\t91\tTO\n' +
    '5\t1\t1\t1\t1\t3\t80\t20\t90\t15\t90\tCONTINUE\n' +
    '5\t1\t2\t1\t1\t1\t200\t200\t20\t15\t-1\tnoise\n';
  const result = parseTsv(tsv);
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].text, 'CLICK TO CONTINUE');
  assert.deepEqual(result.lines[0].bounds, { x: 10, y: 20, width: 160, height: 15 });
});
