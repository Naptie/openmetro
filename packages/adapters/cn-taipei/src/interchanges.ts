/** Official metro interchanges within the Taipei metropolitan network. */
export const METRO_INTERCHANGES = [
  {
    from: 'cn-taipei-station-dapinglin',
    to: 'cn-new-taipei-station-dapinglin',
    source: 'https://www.metro.taipei/News_Content.aspx?n=566DA580861CEE77&s=C2DB2D09B73A31AA',
    outOfStation: false
  },
  {
    from: 'cn-taipei-station-jingan',
    to: 'cn-new-taipei-station-jingan',
    source: 'https://www.metro.taipei/News_Content.aspx?n=566DA580861CEE77&s=C2DB2D09B73A31AA',
    outOfStation: false
  },
  {
    from: 'cn-taipei-station-touqianzhuang',
    to: 'cn-new-taipei-station-touqianzhuang',
    source: 'https://www.metro.taipei/News_Content.aspx?n=566DA580861CEE77&s=C2DB2D09B73A31AA',
    outOfStation: false
  },
  {
    from: 'cn-taipei-station-banqiao',
    to: 'cn-new-taipei-station-banqiao',
    source: 'https://www.metro.taipei/News_Content.aspx?n=566DA580861CEE77&s=C2DB2D09B73A31AA',
    outOfStation: true
  },
  {
    from: 'cn-taipei-station-xinpu',
    to: 'cn-new-taipei-station-xinpu-minsheng',
    source: 'https://www.metro.taipei/News_Content.aspx?n=566DA580861CEE77&s=C2DB2D09B73A31AA',
    outOfStation: true
  },
  {
    from: 'cn-taipei-station-hongshulin',
    to: 'cn-new-taipei-station-hongshulin',
    source: 'https://www.ntmetro.com.tw/basic/?mode=detail&node=36',
    outOfStation: true
  },
  {
    from: 'cn-taipei-station-dingpu',
    to: 'cn-new-taipei-station-dingpu',
    source:
      'https://www.ntpc.gov.tw/uploaddowndoc?file=meetingpaper%2F202604301052040.pdf&filedisplay=1150428-%E6%8D%B7%E9%81%8B%E5%B1%80%E5%B8%82%E6%94%BF%E6%9C%83%E8%AD%B0%E7%B0%A1%E5%A0%B1.pdf&flag=doc',
    outOfStation: false
  },
  {
    from: 'cn-taoyuan-station-taipei-main-station',
    to: 'cn-taipei-station-taipei-main-station',
    source: 'https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/A1/A1',
    outOfStation: true
  },
  {
    from: 'cn-taoyuan-station-taipei-main-station',
    to: 'cn-taipei-station-beimen',
    source: 'https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/A1/A1',
    outOfStation: true
  },
  {
    from: 'cn-taoyuan-station-sanchong',
    to: 'cn-taipei-station-sanchong',
    source: 'https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/A2/A2',
    outOfStation: true,
    seconds: 300
  },
  {
    from: 'cn-taoyuan-station-new-taipei-industrial-park',
    to: 'cn-new-taipei-station-new-taipei-industrial-park',
    source: 'https://www.tymetro.com.tw/tymetro-new/tw/_pages/travel-guide/A3/A3',
    outOfStation: true,
    seconds: 300
  }
] as const;
