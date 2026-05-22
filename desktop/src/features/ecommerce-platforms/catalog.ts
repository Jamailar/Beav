export type EcommercePlatformRecord = {
  id: string;
  name: string;
  market: string;
  platformType: string;
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
      { id: 'alibaba-com', name: 'Alibaba.com', market: '全球', platformType: 'B2B跨境平台' },
    ],
  },
  {
    region: '东南亚',
    platforms: [
      { id: 'shopee', name: 'Shopee', market: '新加坡/马来西亚/泰国/印尼/菲律宾/越南等', platformType: '综合电商' },
      { id: 'lazada', name: 'Lazada', market: '区域/泰国', platformType: '综合电商' },
      { id: 'tiktok-shop-sea', name: 'TikTok Shop', market: '泰国/新加坡/马来西亚/印尼/菲律宾/越南等', platformType: '内容电商/直播电商' },
      { id: 'tokopedia', name: 'Tokopedia', market: '印尼', platformType: '综合电商' },
      { id: 'bukalapak', name: 'Bukalapak', market: '印尼', platformType: '综合电商' },
      { id: 'blibli', name: 'Blibli', market: '印尼', platformType: '综合电商' },
      { id: 'tiki', name: 'Tiki', market: '越南', platformType: '综合电商' },
      { id: 'sendo', name: 'Sendo', market: '越南', platformType: '综合电商' },
      { id: 'zalora', name: 'ZALORA', market: '新加坡/马来西亚/菲律宾/印尼等', platformType: '时尚电商' },
    ],
  },
  {
    region: '欧洲',
    platforms: [
      { id: 'amazon-eu-uk', name: 'Amazon EU/UK', market: 'EU/UK 等', platformType: '综合电商' },
      { id: 'ebay', name: 'eBay', market: 'EU/UK 等', platformType: '综合/拍卖电商' },
      { id: 'etsy', name: 'Etsy', market: 'EU/UK 等', platformType: '手工/设计品平台' },
      { id: 'zalando', name: 'Zalando', market: '德国/荷兰/法国/意大利/西班牙等', platformType: '时尚电商' },
      { id: 'about-you', name: 'ABOUT YOU', market: '德国/奥地利/荷兰等', platformType: '时尚电商' },
      { id: 'allegro', name: 'Allegro', market: '波兰/区域', platformType: '综合电商' },
      { id: 'bol-com', name: 'bol.com', market: '荷兰/比利时', platformType: '综合电商' },
      { id: 'cdiscount-octopia', name: 'Cdiscount / Octopia', market: '法国/欧洲', platformType: '综合电商/Marketplace' },
      { id: 'otto-market', name: 'OTTO Market', market: '德国', platformType: '综合电商' },
      { id: 'kaufland-global-marketplace', name: 'Kaufland Global Marketplace', market: '德国/欧洲', platformType: '综合电商' },
      { id: 'emag', name: 'eMAG', market: '罗马尼亚/保加利亚/匈牙利等', platformType: '综合电商' },
      { id: 'manomano', name: 'ManoMano', market: '法国/欧洲', platformType: '家装/DIY电商' },
    ],
  },
  {
    region: '欧洲 / 跨境',
    platforms: [
      { id: 'temu', name: 'Temu', market: 'EU/UK 等', platformType: '跨境综合电商' },
      { id: 'shein-marketplace', name: 'SHEIN Marketplace', market: 'EU/UK 等', platformType: '跨境时尚电商' },
      { id: 'aliexpress', name: 'AliExpress', market: '欧洲/全球', platformType: '跨境综合电商' },
    ],
  },
  {
    region: '欧洲 / 西亚',
    platforms: [
      { id: 'trendyol', name: 'Trendyol', market: '土耳其/欧洲跨境', platformType: '综合/时尚电商' },
    ],
  },
  {
    region: '中亚 / CIS',
    platforms: [
      { id: 'kaspi-kz', name: 'Kaspi.kz', market: '哈萨克斯坦', platformType: '综合电商/金融生态' },
      { id: 'ozon', name: 'Ozon', market: '俄罗斯/跨境CIS', platformType: '综合电商' },
      { id: 'wildberries', name: 'Wildberries', market: '俄罗斯/中亚跨境', platformType: '综合/时尚电商' },
    ],
  },
  {
    region: '中亚',
    platforms: [
      { id: 'uzum-market', name: 'Uzum Market', market: '乌兹别克斯坦', platformType: '综合电商' },
      { id: 'satu-kz', name: 'Satu.kz', market: '哈萨克斯坦/区域', platformType: 'B2B/B2C marketplace' },
    ],
  },
];

export const ECOMMERCE_PLATFORM_IDS = ECOMMERCE_PLATFORM_GROUPS.flatMap((group) =>
  group.platforms.map((platform) => platform.id)
);

export const createDefaultEcommercePlatformsSettings = (): EcommercePlatformsSettings => ({
  version: 1,
  enabledById: Object.fromEntries(ECOMMERCE_PLATFORM_IDS.map((id) => [id, true])),
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
      ECOMMERCE_PLATFORM_IDS.map((id) => [id, savedEnabledById[id] !== false])
    ),
  };
};

export const serializeEcommercePlatformsSettings = (settings: EcommercePlatformsSettings): string => JSON.stringify({
  version: 1,
  enabledById: Object.fromEntries(
    ECOMMERCE_PLATFORM_IDS.map((id) => [id, settings.enabledById[id] !== false])
  ),
});
