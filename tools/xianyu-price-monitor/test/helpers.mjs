// 构造与闲鱼网页版接口同结构的响应，用于离线测试。

export function searchRow({ id, title, price, area = '上海', seller = '卖家A', want = '3', ts = '1730000000000', freeship = false }) {
  return {
    data: {
      item: {
        main: {
          exContent: {
            itemId: id,
            title,
            price: typeof price === 'string' ? [{ text: '¥' }, { text: price }] : price,
            area,
            userNickName: seller,
            picUrl: `https://img.example/${id}.jpg`,
            oriPrice: '¥9999',
            fishTags: { r1: { tagList: [{ data: { content: '验货宝' } }] } },
          },
          clickParam: { args: { item_id: id, wantNum: want, publishTime: ts, tag: freeship ? 'freeship' : '' } },
          targetUrl: `fleamarket://item?id=${id}`,
        },
      },
    },
  };
}

export function searchResponse(rows, ret = 'SUCCESS::调用成功') {
  return { api: 'mtop.taobao.idlemtopsearch.pc.search', v: '1.0', ret: [ret], data: { resultList: rows } };
}

export function detailResponse({ id, title, soldPrice, itemStatus = 0, ret = 'SUCCESS::调用成功' }) {
  return {
    api: 'mtop.taobao.idle.pc.detail',
    ret: [ret],
    data: { itemDO: { itemId: id, title, soldPrice, originalPrice: '6999', itemStatus, wantCnt: 7, browseCnt: 120 }, sellerDO: { nick: '卖家B', publishCity: '杭州' } },
  };
}

export const failResponse = (ret) => ({ ret: [ret], data: {} });
