export type EcommercePlatformRecord = {
  id: string;
  name: string;
  market: string;
  platformType: string;
  detailPageLocales?: EcommercePlatformDetailPageLocale[];
};

export type EcommercePlatformDetailPageLocale = {
  market: string;
  locale: string;
};

export type EcommercePlatformGroup = {
  region: string;
  platforms: EcommercePlatformRecord[];
};

export type EcommercePlatformsSettings = {
  version: number;
  enabledById: Record<string, boolean>;
};

export const ECOMMERCE_PLATFORM_ICON_PATHS: Record<string, string> = {
  '1688': '/ecommerce-platform-icons/1688.ico',
  'about-you': '/ecommerce-platform-icons/about-you.png',
  'alibaba-com': '/ecommerce-platform-icons/alibaba-com.svg',
  'aliexpress': '/ecommerce-platform-icons/aliexpress.svg',
  'allegro': '/ecommerce-platform-icons/allegro.svg',
  'amazon-eu-uk': '/ecommerce-platform-icons/amazon-eu-uk.png',
  'blibli': '/ecommerce-platform-icons/blibli.svg',
  'bol-com': '/ecommerce-platform-icons/bol-com.png',
  'bukalapak': '/ecommerce-platform-icons/bukalapak.svg',
  'cdiscount-octopia': '/ecommerce-platform-icons/cdiscount-octopia.png',
  'douyin-shop': '/ecommerce-platform-icons/douyin-shop.png',
  'ebay': '/ecommerce-platform-icons/ebay.svg',
  'emag': '/ecommerce-platform-icons/emag.png',
  'etsy': '/ecommerce-platform-icons/etsy.svg',
  'jd': '/ecommerce-platform-icons/jd.png',
  'kaspi-kz': '/ecommerce-platform-icons/kaspi-kz.png',
  'kaufland-global-marketplace': '/ecommerce-platform-icons/kaufland-global-marketplace.svg',
  'kuaishou-shop': '/ecommerce-platform-icons/kuaishou-shop.svg',
  'lazada': '/ecommerce-platform-icons/lazada.png',
  'manomano': '/ecommerce-platform-icons/manomano.png',
  'otto-market': '/ecommerce-platform-icons/otto-market.svg',
  'ozon': '/ecommerce-platform-icons/ozon.png',
  'pinduoduo': '/ecommerce-platform-icons/pinduoduo.png',
  'satu-kz': '/ecommerce-platform-icons/satu-kz.png',
  'sendo': '/ecommerce-platform-icons/sendo.png',
  'shein-marketplace': '/ecommerce-platform-icons/shein-marketplace.png',
  'shopee': '/ecommerce-platform-icons/shopee.svg',
  'taobao-tmall': '/ecommerce-platform-icons/taobao-tmall.svg',
  'temu': '/ecommerce-platform-icons/temu.png',
  'tiki': '/ecommerce-platform-icons/tiki.png',
  'tiktok-shop-sea': '/ecommerce-platform-icons/tiktok-shop-sea.svg',
  'tokopedia': '/ecommerce-platform-icons/tokopedia.png',
  'trendyol': '/ecommerce-platform-icons/trendyol.jpg',
  'uzum-market': '/ecommerce-platform-icons/uzum-market.png',
  'vipshop': '/ecommerce-platform-icons/vipshop.png',
  'wildberries': '/ecommerce-platform-icons/wildberries.png',
  'xiaohongshu-shop': '/ecommerce-platform-icons/xiaohongshu-shop.svg',
  'zalando': '/ecommerce-platform-icons/zalando.svg',
  'zalora': '/ecommerce-platform-icons/zalora.png',
};

export const ecommercePlatformIconPath = (platformId: string): string =>
  ECOMMERCE_PLATFORM_ICON_PATHS[platformId] || '';

const detailLocale = (market: string, locale: string): EcommercePlatformDetailPageLocale => ({
  market,
  locale,
});

export const ECOMMERCE_PLATFORM_GROUPS: EcommercePlatformGroup[] = [
  {
    region: '中国',
    platforms: [
      { id: 'taobao-tmall', name: '淘宝 / 天猫', market: '中国大陆', platformType: '综合电商' },
      { id: 'jd', name: '京东 JD', market: '中国大陆', platformType: '综合电商' },
      { id: 'pinduoduo', name: '拼多多 Pinduoduo', market: '中国大陆', platformType: '综合/社交电商' },
      { id: 'douyin-shop', name: '抖音电商 / 抖店', market: '中国大陆', platformType: '内容电商/直播电商' },
      { id: 'kuaishou-shop', name: '快手小店', market: '中国大陆', platformType: '内容电商/直播电商' },
      { id: '1688', name: '1688', market: '中国大陆', platformType: 'B2B批发平台' },
      { id: 'xiaohongshu-shop', name: '小红书店铺', market: '中国大陆', platformType: '内容种草/电商' },
      { id: 'vipshop', name: '唯品会', market: '中国大陆', platformType: '特卖/品牌电商' },
    ],
  },
  {
    region: '中国 / 跨境',
    platforms: [
      {
        id: 'alibaba-com',
        name: 'Alibaba.com',
        market: '全球',
        platformType: 'B2B跨境平台',
        detailPageLocales: [
          detailLocale('美国', '英语'),
          detailLocale('英国', '英语'),
          detailLocale('德国', '德语'),
          detailLocale('法国', '法语'),
          detailLocale('西班牙', '西班牙语'),
          detailLocale('马来西亚', '英语'),
          detailLocale('泰国', '英语'),
          detailLocale('印尼', '英语'),
          detailLocale('越南', '英语'),
          detailLocale('菲律宾', '英语'),
        ],
      },
    ],
  },
  {
    region: '东南亚',
    platforms: [
      {
        id: 'shopee',
        name: 'Shopee',
        market: '新加坡/马来西亚/泰国/印尼/菲律宾/越南等',
        platformType: '综合电商',
        detailPageLocales: [
          detailLocale('新加坡', '英语'),
          detailLocale('马来西亚', '英语'),
          detailLocale('马来西亚', '马来语'),
          detailLocale('泰国', '泰语'),
          detailLocale('台湾', '繁体中文'),
          detailLocale('印尼', '印尼语'),
          detailLocale('菲律宾', '英语'),
          detailLocale('越南', '越南语'),
          detailLocale('巴西', '葡萄牙语'),
          detailLocale('墨西哥', '西班牙语'),
          detailLocale('哥伦比亚', '西班牙语'),
          detailLocale('智利', '西班牙语'),
        ],
      },
      {
        id: 'lazada',
        name: 'Lazada',
        market: '区域/泰国',
        platformType: '综合电商',
        detailPageLocales: [
          detailLocale('新加坡', '英语'),
          detailLocale('马来西亚', '英语'),
          detailLocale('马来西亚', '马来语'),
          detailLocale('泰国', '泰语'),
          detailLocale('印尼', '印尼语'),
          detailLocale('菲律宾', '英语'),
          detailLocale('越南', '越南语'),
        ],
      },
      {
        id: 'tiktok-shop-sea',
        name: 'TikTok Shop',
        market: '泰国/新加坡/马来西亚/印尼/菲律宾/越南等',
        platformType: '内容电商/直播电商',
        detailPageLocales: [
          detailLocale('新加坡', '英语'),
          detailLocale('马来西亚', '英语'),
          detailLocale('马来西亚', '马来语'),
          detailLocale('泰国', '泰语'),
          detailLocale('印尼', '印尼语'),
          detailLocale('菲律宾', '英语'),
          detailLocale('越南', '越南语'),
          detailLocale('美国', '英语'),
          detailLocale('英国', '英语'),
          detailLocale('爱尔兰', '英语'),
          detailLocale('西班牙', '西班牙语'),
          detailLocale('墨西哥', '西班牙语'),
          detailLocale('德国', '德语'),
          detailLocale('法国', '法语'),
          detailLocale('意大利', '意大利语'),
          detailLocale('日本', '日语'),
          detailLocale('巴西', '葡萄牙语'),
          detailLocale('沙特阿拉伯', '阿拉伯语'),
        ],
      },
      { id: 'tokopedia', name: 'Tokopedia', market: '印尼', platformType: '综合电商', detailPageLocales: [detailLocale('印尼', '印尼语')] },
      { id: 'bukalapak', name: 'Bukalapak', market: '印尼', platformType: '综合电商', detailPageLocales: [detailLocale('印尼', '印尼语')] },
      { id: 'blibli', name: 'Blibli', market: '印尼', platformType: '综合电商', detailPageLocales: [detailLocale('印尼', '印尼语')] },
      { id: 'tiki', name: 'Tiki', market: '越南', platformType: '综合电商', detailPageLocales: [detailLocale('越南', '越南语')] },
      { id: 'sendo', name: 'Sendo', market: '越南', platformType: '综合电商', detailPageLocales: [detailLocale('越南', '越南语')] },
      {
        id: 'zalora',
        name: 'ZALORA',
        market: '新加坡/马来西亚/菲律宾/印尼等',
        platformType: '时尚电商',
        detailPageLocales: [
          detailLocale('新加坡', '英语'),
          detailLocale('马来西亚', '英语'),
          detailLocale('马来西亚', '马来语'),
          detailLocale('菲律宾', '英语'),
          detailLocale('印尼', '印尼语'),
          detailLocale('香港', '繁体中文'),
          detailLocale('香港', '英语'),
          detailLocale('台湾', '繁体中文'),
          detailLocale('文莱', '马来语'),
          detailLocale('文莱', '英语'),
        ],
      },
    ],
  },
  {
    region: '欧洲',
    platforms: [
      {
        id: 'amazon-eu-uk',
        name: 'Amazon EU/UK',
        market: 'EU/UK 等',
        platformType: '综合电商',
        detailPageLocales: [
          detailLocale('英国', '英语'),
          detailLocale('德国', '德语'),
          detailLocale('法国', '法语'),
          detailLocale('意大利', '意大利语'),
          detailLocale('西班牙', '西班牙语'),
          detailLocale('荷兰', '荷兰语'),
          detailLocale('波兰', '波兰语'),
          detailLocale('瑞典', '瑞典语'),
          detailLocale('比利时', '荷兰语'),
          detailLocale('比利时', '法语'),
          detailLocale('爱尔兰', '英语'),
        ],
      },
      {
        id: 'ebay',
        name: 'eBay',
        market: 'EU/UK 等',
        platformType: '综合/拍卖电商',
        detailPageLocales: [
          detailLocale('英国', '英语'),
          detailLocale('德国', '德语'),
          detailLocale('法国', '法语'),
          detailLocale('意大利', '意大利语'),
          detailLocale('西班牙', '西班牙语'),
          detailLocale('荷兰', '荷兰语'),
          detailLocale('波兰', '波兰语'),
          detailLocale('瑞典', '瑞典语'),
          detailLocale('比利时', '荷兰语'),
          detailLocale('比利时', '法语'),
          detailLocale('爱尔兰', '英语'),
        ],
      },
      {
        id: 'etsy',
        name: 'Etsy',
        market: 'EU/UK 等',
        platformType: '手工/设计品平台',
        detailPageLocales: [
          detailLocale('美国', '英语'),
          detailLocale('英国', '英语'),
          detailLocale('德国', '德语'),
          detailLocale('法国', '法语'),
          detailLocale('意大利', '意大利语'),
          detailLocale('西班牙', '西班牙语'),
          detailLocale('荷兰', '荷兰语'),
          detailLocale('波兰', '波兰语'),
          detailLocale('瑞典', '瑞典语'),
          detailLocale('比利时', '荷兰语'),
          detailLocale('比利时', '法语'),
          detailLocale('爱尔兰', '英语'),
        ],
      },
      {
        id: 'zalando',
        name: 'Zalando',
        market: '德国/荷兰/法国/意大利/西班牙等',
        platformType: '时尚电商',
        detailPageLocales: [
          detailLocale('德国', '德语'),
          detailLocale('荷兰', '荷兰语'),
          detailLocale('法国', '法语'),
          detailLocale('意大利', '意大利语'),
          detailLocale('西班牙', '西班牙语'),
          detailLocale('奥地利', '德语'),
          detailLocale('瑞士', '德语'),
          detailLocale('瑞士', '法语'),
          detailLocale('瑞士', '意大利语'),
          detailLocale('比利时', '荷兰语'),
          detailLocale('比利时', '法语'),
          detailLocale('波兰', '波兰语'),
          detailLocale('瑞典', '瑞典语'),
          detailLocale('丹麦', '丹麦语'),
          detailLocale('芬兰', '芬兰语'),
          detailLocale('挪威', '挪威语'),
          detailLocale('爱尔兰', '英语'),
          detailLocale('英国', '英语'),
          detailLocale('捷克', '捷克语'),
          detailLocale('斯洛伐克', '斯洛伐克语'),
          detailLocale('斯洛文尼亚', '斯洛文尼亚语'),
          detailLocale('克罗地亚', '克罗地亚语'),
          detailLocale('匈牙利', '匈牙利语'),
          detailLocale('罗马尼亚', '罗马尼亚语'),
          detailLocale('爱沙尼亚', '爱沙尼亚语'),
          detailLocale('拉脱维亚', '拉脱维亚语'),
          detailLocale('立陶宛', '立陶宛语'),
          detailLocale('卢森堡', '法语'),
          detailLocale('卢森堡', '德语'),
        ],
      },
      {
        id: 'about-you',
        name: 'ABOUT YOU',
        market: '德国/奥地利/荷兰等',
        platformType: '时尚电商',
        detailPageLocales: [
          detailLocale('德国', '德语'),
          detailLocale('奥地利', '德语'),
          detailLocale('荷兰', '荷兰语'),
          detailLocale('比利时', '荷兰语'),
          detailLocale('比利时', '法语'),
          detailLocale('瑞士', '德语'),
          detailLocale('瑞士', '法语'),
          detailLocale('瑞士', '意大利语'),
          detailLocale('波兰', '波兰语'),
          detailLocale('捷克', '捷克语'),
          detailLocale('斯洛伐克', '斯洛伐克语'),
          detailLocale('匈牙利', '匈牙利语'),
          detailLocale('罗马尼亚', '罗马尼亚语'),
          detailLocale('斯洛文尼亚', '斯洛文尼亚语'),
          detailLocale('克罗地亚', '克罗地亚语'),
          detailLocale('爱沙尼亚', '爱沙尼亚语'),
          detailLocale('拉脱维亚', '拉脱维亚语'),
          detailLocale('立陶宛', '立陶宛语'),
        ],
      },
      { id: 'allegro', name: 'Allegro', market: '波兰/区域', platformType: '综合电商', detailPageLocales: [detailLocale('波兰', '波兰语')] },
      {
        id: 'bol-com',
        name: 'bol.com',
        market: '荷兰/比利时',
        platformType: '综合电商',
        detailPageLocales: [
          detailLocale('荷兰', '荷兰语'),
          detailLocale('比利时', '荷兰语'),
          detailLocale('比利时', '法语'),
        ],
      },
      {
        id: 'cdiscount-octopia',
        name: 'Cdiscount / Octopia',
        market: '法国/欧洲',
        platformType: '综合电商/Marketplace',
        detailPageLocales: [
          detailLocale('法国', '法语'),
          detailLocale('比利时', '法语'),
          detailLocale('比利时', '荷兰语'),
          detailLocale('德国', '德语'),
          detailLocale('西班牙', '西班牙语'),
          detailLocale('意大利', '意大利语'),
          detailLocale('荷兰', '荷兰语'),
          detailLocale('葡萄牙', '葡萄牙语'),
        ],
      },
      { id: 'otto-market', name: 'OTTO Market', market: '德国', platformType: '综合电商', detailPageLocales: [detailLocale('德国', '德语')] },
      {
        id: 'kaufland-global-marketplace',
        name: 'Kaufland Global Marketplace',
        market: '德国/欧洲',
        platformType: '综合电商',
        detailPageLocales: [
          detailLocale('德国', '德语'),
          detailLocale('奥地利', '德语'),
          detailLocale('波兰', '波兰语'),
          detailLocale('捷克', '捷克语'),
          detailLocale('斯洛伐克', '斯洛伐克语'),
        ],
      },
      {
        id: 'emag',
        name: 'eMAG',
        market: '罗马尼亚/保加利亚/匈牙利等',
        platformType: '综合电商',
        detailPageLocales: [
          detailLocale('罗马尼亚', '罗马尼亚语'),
          detailLocale('保加利亚', '保加利亚语'),
          detailLocale('匈牙利', '匈牙利语'),
        ],
      },
      {
        id: 'manomano',
        name: 'ManoMano',
        market: '法国/欧洲',
        platformType: '家装/DIY电商',
        detailPageLocales: [
          detailLocale('法国', '法语'),
          detailLocale('德国', '德语'),
          detailLocale('西班牙', '西班牙语'),
          detailLocale('意大利', '意大利语'),
          detailLocale('英国', '英语'),
          detailLocale('比利时', '法语'),
          detailLocale('比利时', '荷兰语'),
        ],
      },
    ],
  },
  {
    region: '欧洲 / 跨境',
    platforms: [
      {
        id: 'temu',
        name: 'Temu',
        market: 'EU/UK 等',
        platformType: '跨境综合电商',
        detailPageLocales: [
          detailLocale('美国', '英语'),
          detailLocale('英国', '英语'),
          detailLocale('德国', '德语'),
          detailLocale('法国', '法语'),
          detailLocale('西班牙', '西班牙语'),
          detailLocale('意大利', '意大利语'),
          detailLocale('荷兰', '荷兰语'),
          detailLocale('波兰', '波兰语'),
          detailLocale('瑞典', '瑞典语'),
          detailLocale('比利时', '荷兰语'),
          detailLocale('比利时', '法语'),
          detailLocale('爱尔兰', '英语'),
          detailLocale('日本', '日语'),
          detailLocale('墨西哥', '西班牙语'),
          detailLocale('澳大利亚', '英语'),
        ],
      },
      {
        id: 'shein-marketplace',
        name: 'SHEIN Marketplace',
        market: 'EU/UK 等',
        platformType: '跨境时尚电商',
        detailPageLocales: [
          detailLocale('美国', '英语'),
          detailLocale('英国', '英语'),
          detailLocale('德国', '德语'),
          detailLocale('法国', '法语'),
          detailLocale('西班牙', '西班牙语'),
          detailLocale('意大利', '意大利语'),
          detailLocale('荷兰', '荷兰语'),
          detailLocale('波兰', '波兰语'),
          detailLocale('瑞典', '瑞典语'),
          detailLocale('比利时', '荷兰语'),
          detailLocale('比利时', '法语'),
          detailLocale('爱尔兰', '英语'),
          detailLocale('澳大利亚', '英语'),
          detailLocale('加拿大', '英语'),
          detailLocale('加拿大', '法语'),
          detailLocale('阿联酋', '阿拉伯语'),
          detailLocale('沙特阿拉伯', '阿拉伯语'),
        ],
      },
      {
        id: 'aliexpress',
        name: 'AliExpress',
        market: '欧洲/全球',
        platformType: '跨境综合电商',
        detailPageLocales: [
          detailLocale('美国', '英语'),
          detailLocale('德国', '德语'),
          detailLocale('法国', '法语'),
          detailLocale('西班牙', '西班牙语'),
          detailLocale('巴西', '葡萄牙语'),
          detailLocale('意大利', '意大利语'),
          detailLocale('荷兰', '荷兰语'),
          detailLocale('波兰', '波兰语'),
          detailLocale('土耳其', '土耳其语'),
          detailLocale('葡萄牙', '葡萄牙语'),
          detailLocale('俄罗斯', '俄语'),
          detailLocale('韩国', '韩语'),
          detailLocale('日本', '日语'),
          detailLocale('泰国', '泰语'),
          detailLocale('越南', '越南语'),
          detailLocale('印尼', '印尼语'),
          detailLocale('墨西哥', '西班牙语'),
          detailLocale('沙特阿拉伯', '阿拉伯语'),
        ],
      },
    ],
  },
  {
    region: '欧洲 / 西亚',
    platforms: [
      {
        id: 'trendyol',
        name: 'Trendyol',
        market: '土耳其/欧洲跨境',
        platformType: '综合/时尚电商',
        detailPageLocales: [
          detailLocale('土耳其', '土耳其语'),
          detailLocale('德国', '德语'),
          detailLocale('阿塞拜疆', '阿塞拜疆语'),
          detailLocale('沙特阿拉伯', '阿拉伯语'),
          detailLocale('阿联酋', '阿拉伯语'),
          detailLocale('卡塔尔', '阿拉伯语'),
          detailLocale('科威特', '阿拉伯语'),
          detailLocale('巴林', '阿拉伯语'),
          detailLocale('阿曼', '阿拉伯语'),
        ],
      },
    ],
  },
  {
    region: '中亚 / CIS',
    platforms: [
      {
        id: 'kaspi-kz',
        name: 'Kaspi.kz',
        market: '哈萨克斯坦',
        platformType: '综合电商/金融生态',
        detailPageLocales: [
          detailLocale('哈萨克斯坦', '俄语'),
          detailLocale('哈萨克斯坦', '哈萨克语'),
        ],
      },
      {
        id: 'ozon',
        name: 'Ozon',
        market: '俄罗斯/跨境CIS',
        platformType: '综合电商',
        detailPageLocales: [
          detailLocale('俄罗斯', '俄语'),
          detailLocale('白俄罗斯', '俄语'),
          detailLocale('哈萨克斯坦', '俄语'),
          detailLocale('哈萨克斯坦', '哈萨克语'),
          detailLocale('亚美尼亚', '亚美尼亚语'),
          detailLocale('亚美尼亚', '俄语'),
          detailLocale('吉尔吉斯斯坦', '吉尔吉斯语'),
          detailLocale('吉尔吉斯斯坦', '俄语'),
        ],
      },
      {
        id: 'wildberries',
        name: 'Wildberries',
        market: '俄罗斯/中亚跨境',
        platformType: '综合/时尚电商',
        detailPageLocales: [
          detailLocale('俄罗斯', '俄语'),
          detailLocale('白俄罗斯', '俄语'),
          detailLocale('哈萨克斯坦', '俄语'),
          detailLocale('哈萨克斯坦', '哈萨克语'),
          detailLocale('亚美尼亚', '亚美尼亚语'),
          detailLocale('亚美尼亚', '俄语'),
          detailLocale('吉尔吉斯斯坦', '吉尔吉斯语'),
          detailLocale('吉尔吉斯斯坦', '俄语'),
          detailLocale('乌兹别克斯坦', '乌兹别克语'),
          detailLocale('乌兹别克斯坦', '俄语'),
          detailLocale('阿塞拜疆', '阿塞拜疆语'),
          detailLocale('格鲁吉亚', '格鲁吉亚语'),
          detailLocale('塔吉克斯坦', '塔吉克语'),
          detailLocale('塔吉克斯坦', '俄语'),
        ],
      },
    ],
  },
  {
    region: '中亚',
    platforms: [
      {
        id: 'uzum-market',
        name: 'Uzum Market',
        market: '乌兹别克斯坦',
        platformType: '综合电商',
        detailPageLocales: [
          detailLocale('乌兹别克斯坦', '乌兹别克语'),
          detailLocale('乌兹别克斯坦', '俄语'),
        ],
      },
      {
        id: 'satu-kz',
        name: 'Satu.kz',
        market: '哈萨克斯坦/区域',
        platformType: 'B2B/B2C marketplace',
        detailPageLocales: [
          detailLocale('哈萨克斯坦', '俄语'),
          detailLocale('哈萨克斯坦', '哈萨克语'),
        ],
      },
    ],
  },
];

export const ECOMMERCE_PLATFORM_IDS = ECOMMERCE_PLATFORM_GROUPS.flatMap((group) =>
  group.platforms.map((platform) => platform.id)
);

export const DEFAULT_ENABLED_ECOMMERCE_PLATFORM_IDS = new Set([
  'taobao-tmall',
  'xiaohongshu-shop',
  'shopee',
  'lazada',
  'shein-marketplace',
  'temu',
  'ozon',
]);

export const createDefaultEcommercePlatformsSettings = (): EcommercePlatformsSettings => ({
  version: 1,
  enabledById: Object.fromEntries(
    ECOMMERCE_PLATFORM_IDS.map((id) => [id, DEFAULT_ENABLED_ECOMMERCE_PLATFORM_IDS.has(id)])
  ),
});

export const normalizeEcommercePlatformsSettings = (value: unknown): EcommercePlatformsSettings => {
  const defaults = createDefaultEcommercePlatformsSettings();
  if (!value) return defaults;
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return defaults;
    }
  }
  const record = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const savedEnabledById = record.enabledById && typeof record.enabledById === 'object'
    ? record.enabledById as Record<string, unknown>
    : {};
  return {
    version: 1,
    enabledById: Object.fromEntries(
      ECOMMERCE_PLATFORM_IDS.map((id) => [
        id,
        typeof savedEnabledById[id] === 'boolean'
          ? savedEnabledById[id]
          : defaults.enabledById[id] === true,
      ])
    ),
  };
};

export const serializeEcommercePlatformsSettings = (settings: EcommercePlatformsSettings): string => JSON.stringify({
  version: 1,
  enabledById: Object.fromEntries(
    ECOMMERCE_PLATFORM_IDS.map((id) => [id, settings.enabledById[id] !== false])
  ),
});
