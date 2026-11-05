import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRet, extractItemId, parseDetail, parseJsonLoose, parsePrice, parseSearch } from '../src/parse.mjs';
import { detailResponse, searchResponse, searchRow } from './helpers.mjs';

test('parsePrice 兼容各种写法', () => {
  assert.equal(parsePrice('¥1,299'), 1299);
  assert.equal(parsePrice('1.2万'), 12000);
  assert.equal(parsePrice('当前价¥88.5'), 88.5);
  assert.equal(parsePrice([{ text: '¥' }, { text: '4299' }, { text: '.50' }]), 4299.5);
  assert.equal(parsePrice({ text: '￥ 66' }), 66);
  assert.equal(parsePrice(350), 350);
  assert.equal(parsePrice('面议'), null);
  assert.equal(parsePrice(null), null);
});

test('classifyRet 区分成功 / 令牌 / 登录 / 风控', () => {
  assert.equal(classifyRet({ ret: ['SUCCESS::调用成功'] }).kind, 'ok');
  assert.equal(classifyRet({ ret: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'] }).kind, 'token');
  assert.equal(classifyRet({ ret: ['FAIL_SYS_TOKEN_EXOIRED::令牌过期'] }).kind, 'token');
  assert.equal(classifyRet({ ret: ['FAIL_SYS_SESSION_EXPIRED::Session过期'] }).kind, 'login');
  assert.equal(classifyRet({ ret: ['FAIL_SYS_USER_VALIDATE', 'RGV587_ERROR::SM::哎哟喂,被挤爆啦,请稍后重试'] }).kind, 'risk');
  assert.equal(classifyRet({ ret: ['FAIL_BIZ_XXX::其他'] }).kind, 'error');
});

test('parseJsonLoose 兼容 JSONP', () => {
  assert.deepEqual(parseJsonLoose('mtopjsonp3({"ret":["SUCCESS"]})'), { ret: ['SUCCESS'] });
  assert.equal(parseJsonLoose('<html>'), null);
});

test('extractItemId', () => {
  assert.equal(extractItemId('https://www.goofish.com/item?spm=a.b&id=78901234567&categoryId=1'), '78901234567');
  assert.equal(extractItemId('https://m.tb.cn/h.abc'), null);
});

test('parseSearch 提取商品并跳过非商品卡片', () => {
  const json = searchResponse([
    searchRow({ id: '111', title: 'iPhone 15 Pro 256G 原色', price: '4599', freeship: true }),
    { data: { banner: { title: '广告' } } },
    searchRow({ id: '222', title: '徕卡相机', price: '1.25万' }),
  ]);
  const items = parseSearch(json);
  assert.equal(items.length, 2);
  assert.deepEqual(
    { id: items[0].itemId, price: items[0].price, want: items[0].wantCount, url: items[0].url },
    { id: '111', price: 4599, want: 3, url: 'https://www.goofish.com/item?id=111' },
  );
  assert.deepEqual(items[0].tags, ['包邮', '验货宝']);
  assert.equal(items[1].price, 12500);
  assert.equal(items[0].publishTime, new Date(1730000000000).toISOString());
});

test('parseDetail 解析价格与状态', () => {
  const onsale = parseDetail(detailResponse({ id: '333', title: 'Switch OLED', soldPrice: '1450' }));
  assert.equal(onsale.price, 1450);
  assert.equal(onsale.status, 'onsale');
  assert.equal(onsale.seller, '卖家B');
  const sold = parseDetail(detailResponse({ id: '333', title: 'Switch OLED', soldPrice: '1450', itemStatus: 1 }));
  assert.equal(sold.status, 'offline');
});

test('findWantCount：wantNum 缺失时从卡片文字里找"N人想要"', async () => {
  const { findWantCount } = await import('../src/parse.mjs');
  assert.equal(findWantCount({}, { wantNum: '12' }), 12);
  assert.equal(findWantCount({ fishTags: { r3: { tagList: [{ data: { content: '37人想要' } }] } } }, {}), 37);
  assert.equal(findWantCount({ fishTags: { r3: { tagList: [{ data: { content: '1.2万人想要' } }] } } }, {}), 12000);
  assert.equal(findWantCount({ title: '无' }, {}), null);
});
