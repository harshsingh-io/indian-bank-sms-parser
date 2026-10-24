import { test, assertSame, assertNull, assertThrows } from '../harness.mjs';
import { toPaise, tryToPaise, format } from '../../src/money.ts';

/** Money is integer paise, never floats. */

test('money: plain rupees', () => {
  assertSame(18000, toPaise('180'));
  assertSame(0, toPaise('0'));
});

test('money: one decimal place means tens of paise, not units', () => {
  // "180.5" is 180 rupees 50 paise. Padding the wrong side gives 5 paise.
  assertSame(18050, toPaise('180.5'));
});

test('money: indian digit grouping', () => {
  assertSame(123450, toPaise('1,234.50'));
  assertSame(12345678, toPaise('1,23,456.78'));
});

test('money: currency markers and whitespace are tolerated', () => {
  assertSame(18000, toPaise(' Rs.180.00 '));
  assertSame(18000, toPaise('INR 180'));
  assertSame(18000, toPaise('₹180'));
});

test('money: amounts that lose precision as floats', () => {
  // 0.1 + 0.2 territory: exactly the values a float gets wrong.
  assertSame(1010, toPaise('10.10'));
  assertSame(70070, toPaise('700.70'));
  assertSame(999999999, toPaise('99,99,999.99'));
});

test('money: rejects things that are not amounts', async () => {
  await assertThrows(() => toPaise(''), 'empty string must throw');
  await assertThrows(() => toPaise('abc'), 'letters must throw');
  await assertThrows(() => toPaise('1.234'), 'three decimals must throw');
  await assertThrows(() => toPaise('1.2.3'), 'two dots must throw');
  assertNull(tryToPaise('abc'));
  assertNull(tryToPaise(null));
});

test('money: format is the inverse of toPaise', () => {
  for (const t of ['180.00', '0.05', '1234.50', '99999.99']) {
    assertSame(t, format(toPaise(t)), `round trip ${t}`);
  }
  assertSame('-180.00', format(-18000));
});
