/* ═══════════════════════════════════════════════════
   Bybit Futures Dashboard v2
   캔들+MA+피보나치+이치모쿠+RSI+MACD+CCI+OBV+VWAP+ATR
   +Williams%R+공포탐욕+청산히트맵+알람+하모닉패턴
   ═══════════════════════════════════════════════════ */

let currentSymbol='BTCUSDT',currentInterval='60',ws=null,refreshInterval=null;
let tvChartObj=null,candleSeries=null,volumeSeries=null,maSeries={};
let ichimokuSenkouA=null,ichimokuSenkouB=null,ichimokuTenkan=null,ichimokuKijun=null;
let fibLines=[];
let liqBubbleSeries=null; // 청산물량 버블 시리즈
let rsiChartObj=null,rsiLine=null;
let macdChartObj=null,macdLine=null,macdSignal=null,macdHist=null;
let orderbookChart=null,liqChart=null;
let lastKlineData=[];

const G='#00d26a',GD='rgba(0,210,106,0.3)',R='#ff4757',RD='rgba(255,71,87,0.3)';
const BL='#58a6ff',YL='#f0b90b',GR='rgba(48,54,61,0.5)',TX='#8b949e';
const MA_C={7:'#f0b90b',15:'#ff9f43',20:'#00d26a',100:'#58a6ff',200:'#a855f7',400:'#ec4899'};
const MA_P=[7,15,20,100,200,400];

/* ───── 유틸 ───── */
function fmt(n,d=2){if(n==null)return'-';const v=parseFloat(n);if(isNaN(v))return'-';if(Math.abs(v)>=1e9)return(v/1e9).toFixed(2)+'B';if(Math.abs(v)>=1e6)return(v/1e6).toFixed(2)+'M';if(Math.abs(v)>=1e3)return(v/1e3).toFixed(2)+'K';return v.toFixed(d);}
function fp(n){const v=parseFloat(n);if(isNaN(v))return'-';if(v>=1000)return v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});if(v>=1)return v.toFixed(4);return v.toFixed(6);}
async function fetchJSON(u){const r=await fetch(u);if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}

/* ───── Bybit 직접 호출 (서버 403 우회) ───── */
const BYBIT_API='https://api.bybit.com';
async function bybitGet(path,params={}){
    const qs=new URLSearchParams(params).toString();
    const url=`${BYBIT_API}${path}${qs?'?'+qs:''}`;
    const r=await fetch(url);
    if(!r.ok)throw new Error(`Bybit HTTP ${r.status}`);
    const d=await r.json();
    if(d.retCode!==0)throw new Error(`Bybit: ${d.retMsg}`);
    return d.result;
}
async function bybitKline(sym,interval='60',limit=500){
    const res=await bybitGet('/v5/market/kline',{category:'linear',symbol:sym,interval,limit});
    return res.list.reverse().map(c=>({time:parseInt(c[0])/1000,open:+c[1],high:+c[2],low:+c[3],close:+c[4],volume:+c[5],turnover:+c[6]}));
}
async function bybitTickers(sym){
    const res=await bybitGet('/v5/market/tickers',{category:'linear',symbol:sym});
    return res.list[0]||{};
}
async function bybitOrderbook(sym,limit=200){
    return await bybitGet('/v5/market/orderbook',{category:'linear',symbol:sym,limit});
}
async function bybitOI(sym,interval='1h',limit=50){
    const res=await bybitGet('/v5/market/open-interest',{category:'linear',symbol:sym,intervalTime:interval,limit});
    return res.list;
}
async function bybitRatio(sym,period='1h',limit=50){
    const res=await bybitGet('/v5/market/account-ratio',{category:'linear',symbol:sym,period,limit});
    return res.list;
}
async function bybitAllTickers(){
    const res=await bybitGet('/v5/market/tickers',{category:'linear'});
    return res.list;
}

/* ───── 청산 히트맵 추정 (liquidation.py → JS 포팅) ───── */
const LEV_WEIGHTS={3:0.15,5:0.25,10:0.25,25:0.20,50:0.10,100:0.05};
const LEV_LEVELS=[3,5,10,25,50,100];

function estimateLiquidationLevels(currentPrice,oiValue,bids,asks,rangeP=0.15,bins=100){
    if(currentPrice<=0)return{price_levels:[],long_liquidations:[],short_liquidations:[],leverage_markers:[],current_price:0};
    const low=currentPrice*(1-rangeP),high=currentPrice*(1+rangeP);
    const priceLevels=[];
    for(let i=0;i<bins;i++)priceLevels.push(low+(high-low)*i/(bins-1));
    const longLiqs=new Float64Array(bins);
    const shortLiqs=new Float64Array(bins);
    const leverageMarkers=[];
    const SQRT2PI=Math.sqrt(2*Math.PI);

    for(const lev of LEV_LEVELS){
        const weight=LEV_WEIGHTS[lev];
        const oiPortion=oiValue*weight;
        const mm=0.005;
        const longLiqP=currentPrice*(1-(1/lev)+mm);
        const shortLiqP=currentPrice*(1+(1/lev)-mm);
        leverageMarkers.push({leverage:`${lev}x`,long_liq_price:+longLiqP.toFixed(6),short_liq_price:+shortLiqP.toFixed(6)});
        const sigma=currentPrice*(0.003+0.05/lev);
        const invSigma=1/sigma;
        for(let i=0;i<bins;i++){
            const p=priceLevels[i];
            if(p<currentPrice){
                const dist=Math.abs(p-longLiqP);
                const w=Math.exp(-0.5*(dist*invSigma)**2);
                longLiqs[i]+=oiPortion*w*invSigma/SQRT2PI;
            }else{
                const dist=Math.abs(p-shortLiqP);
                const w=Math.exp(-0.5*(dist*invSigma)**2);
                shortLiqs[i]+=oiPortion*w*invSigma/SQRT2PI;
            }
        }
    }
    // 호가창 대형 매물벽 반영
    if(bids&&asks&&bids.length&&asks.length){
        let maxQ=1;
        const allQ=[...bids.map(b=>parseFloat(b[1])),...asks.map(a=>parseFloat(a[1]))];
        if(allQ.length)maxQ=Math.max(...allQ);
        for(const bid of bids.slice(0,50)){
            const bp=parseFloat(bid[0]),bq=parseFloat(bid[1]);
            if(bq>maxQ*0.3){
                for(let i=0;i<bins;i++){
                    if(Math.abs(priceLevels[i]-bp*0.98)<currentPrice*0.005)
                        longLiqs[i]+=bq/maxQ*20;
                }
            }
        }
        for(const ask of asks.slice(0,50)){
            const ap=parseFloat(ask[0]),aq=parseFloat(ask[1]);
            if(aq>maxQ*0.3){
                for(let i=0;i<bins;i++){
                    if(Math.abs(priceLevels[i]-ap*1.02)<currentPrice*0.005)
                        shortLiqs[i]+=aq/maxQ*20;
                }
            }
        }
    }
    // 정규화: 최대값=100
    let maxV=1;
    for(let i=0;i<bins;i++){if(longLiqs[i]>maxV)maxV=longLiqs[i];if(shortLiqs[i]>maxV)maxV=shortLiqs[i];}
    const longArr=[],shortArr=[],plArr=[];
    for(let i=0;i<bins;i++){
        longArr.push(+(longLiqs[i]/maxV*100).toFixed(2));
        shortArr.push(+(shortLiqs[i]/maxV*100).toFixed(2));
        plArr.push(+priceLevels[i].toFixed(6));
    }
    return{price_levels:plArr,long_liquidations:longArr,short_liquidations:shortArr,leverage_markers:leverageMarkers,current_price:currentPrice};
}

/* ───── 브라우저에서 청산 데이터 계산 ───── */
async function fetchLiquidationData(sym){
    const [ticker,oiList,ob]=await Promise.all([
        bybitTickers(sym),
        bybitOI(sym,'1h',1),
        bybitOrderbook(sym,200)
    ]);
    const curPrice=parseFloat(ticker.lastPrice||0);
    const oiVal=oiList.length?parseFloat(oiList[0].openInterest)*curPrice:0;
    return estimateLiquidationLevels(curPrice,oiVal,ob.b||[],ob.a||[]);
}

/* ───── CME 갭 감지 (브라우저 측) ───── */
async function fetchCMEGaps(sym){
    const kline=await bybitKline(sym,'60',500);
    const fridayCloses={},sundayOpens={};
    for(const c of kline){
        const dt=new Date(c.time*1000);
        const utcDay=dt.getUTCDay(),utcHour=dt.getUTCHours();
        // ISO week number
        const d2=new Date(Date.UTC(dt.getUTCFullYear(),dt.getUTCMonth(),dt.getUTCDate()));
        d2.setUTCDate(d2.getUTCDate()+4-(d2.getUTCDay()||7));
        const wk=Math.ceil(((d2-new Date(Date.UTC(d2.getUTCFullYear(),0,1)))/86400000+1)/7);
        if(utcDay===5&&utcHour===21)fridayCloses[wk]=c; // 금요일 21시
        if(utcDay===0&&utcHour===22)sundayOpens[wk+1]=c; // 일요일 22시
    }
    const gaps=[];
    for(const[wkStr,sun] of Object.entries(sundayOpens)){
        const wk=parseInt(wkStr);
        const fri=fridayCloses[wk-1]||fridayCloses[wk];
        if(!fri)continue;
        const gap=sun.open-fri.close;
        const gapPct=gap/fri.close*100;
        if(Math.abs(gapPct)<0.05)continue;
        let filled=false;
        for(const c of kline){
            if(c.time>sun.time){
                if(gap>0&&c.low<=fri.close){filled=true;break;}
                if(gap<0&&c.high>=fri.close){filled=true;break;}
            }
        }
        gaps.push({time:sun.time,gap_open:sun.open,prev_close:fri.close,gap:+gap.toFixed(2),gap_pct:+gapPct.toFixed(2),filled});
    }
    return gaps.slice(-5);
}

/* ───── 거래량 급증 감지 (브라우저 측) ───── */
async function fetchVolumeAlerts(){
    const allTickers=await bybitAllTickers();
    const candidates=[];
    for(const t of allTickers){
        const sym=t.symbol;
        if(!sym.endsWith('USDT'))continue;
        const priceChg=Math.abs(parseFloat(t.price24hPcnt||0)*100);
        const turnover=parseFloat(t.turnover24h||0);
        if(turnover>1000000||priceChg>10)candidates.push(t);
    }
    candidates.sort((a,b)=>parseFloat(b.turnover24h||0)-parseFloat(a.turnover24h||0));
    const checkList=candidates.slice(0,30); // 30개로 제한 (브라우저 부하 고려)
    const alerts=[];
    // 병렬로 15분봉 체크 (5개씩 배치)
    for(let b=0;b<checkList.length;b+=5){
        const batch=checkList.slice(b,b+5);
        const results=await Promise.allSettled(batch.map(async t=>{
            const sym=t.symbol;
            const price=parseFloat(t.lastPrice||0);
            const priceChg=parseFloat(t.price24hPcnt||0)*100;
            const turnover=parseFloat(t.turnover24h||0);
            const alertReasons=[];
            let score=0;
            if(Math.abs(priceChg)>=15){
                alertReasons.push(`24h ${priceChg>0?'급등':'급락'} ${priceChg>0?'+':''}${priceChg.toFixed(1)}%`);
                score+=Math.abs(priceChg);
            }
            try{
                const kl=await bybitGet('/v5/market/kline',{category:'linear',symbol:sym,interval:'15',limit:'6'});
                const klList=kl.list||[];
                if(klList.length>=6){
                    const curVol=parseFloat(klList[0][5]);
                    const prevVols=klList.slice(1,6).map(k=>parseFloat(k[5]));
                    const avgPrev=prevVols.reduce((a,b)=>a+b,0)/prevVols.length;
                    if(avgPrev>0&&curVol>avgPrev*3){
                        const ratio=curVol/avgPrev;
                        alertReasons.push(`15분봉 거래량 ${ratio.toFixed(1)}배 급증`);
                        score+=ratio*20;
                    }
                }
            }catch(e){}
            if(Math.abs(priceChg)>=30)score+=100;
            if(score>0&&alertReasons.length){
                return{symbol:sym,reasons:alertReasons,score:+score.toFixed(1),price,price_change:+priceChg.toFixed(2),volume:parseFloat(t.volume24h||0),turnover};
            }
            return null;
        }));
        results.forEach(r=>{if(r.status==='fulfilled'&&r.value)alerts.push(r.value);});
    }
    alerts.sort((a,b)=>b.score-a.score);
    return alerts.slice(0,15);
}

/* ═══════════════════════════════════
   기술적 지표 계산 함수들
   ═══════════════════════════════════ */
function calcSMA(d,p){const r=[];for(let i=0;i<d.length;i++){if(i<p-1){r.push(null);continue;}let s=0;for(let j=i-p+1;j<=i;j++)s+=d[j].close;r.push({time:d[i].time,value:s/p});}return r.filter(x=>x!==null);}

function calcEMA(arr,p){const r=[];if(arr.length<p)return r;let s=0;for(let i=0;i<p;i++)s+=arr[i];let e=s/p;r.push(e);const k=2/(p+1);for(let i=p;i<arr.length;i++){e=arr[i]*k+e*(1-k);r.push(e);}return r;}

function calcRSI(d,p=14){const r=[];if(d.length<p+1)return r;let g=0,l=0;for(let i=1;i<=p;i++){const df=d[i].close-d[i-1].close;if(df>0)g+=df;else l-=df;}let ag=g/p,al=l/p;r.push({time:d[p].time,value:al===0?100:100-(100/(1+ag/al))});for(let i=p+1;i<d.length;i++){const df=d[i].close-d[i-1].close;ag=(ag*(p-1)+(df>0?df:0))/p;al=(al*(p-1)+(df<0?-df:0))/p;r.push({time:d[i].time,value:al===0?100:100-(100/(1+ag/al))});}return r;}

function calcMACD(d,f=12,s=26,sig=9){const cl=d.map(x=>x.close),ef=calcEMA(cl,f),es=calcEMA(cl,s),ml=[];const o=s-f;for(let i=0;i<es.length;i++)ml.push(ef[i+o]-es[i]);const sl=calcEMA(ml,sig);const r={macd:[],signal:[],hist:[]};const si=s-1,so=sig-1;for(let i=0;i<sl.length;i++){const idx=si+so+i;if(idx>=d.length)break;const m=ml[i+so],sv=sl[i];r.macd.push({time:d[idx].time,value:m});r.signal.push({time:d[idx].time,value:sv});r.hist.push({time:d[idx].time,value:m-sv,color:m-sv>=0?G:R});}return r;}

function calcCCI(d,p=20){if(d.length<p)return null;const last=d.slice(-p);const tps=last.map(c=>(c.high+c.low+c.close)/3);const mean=tps.reduce((a,b)=>a+b,0)/p;const md=tps.reduce((a,b)=>a+Math.abs(b-mean),0)/p;return md===0?0:(tps[tps.length-1]-mean)/(0.015*md);}

function calcOBV(d){let obv=0;for(let i=1;i<d.length;i++){if(d[i].close>d[i-1].close)obv+=d[i].volume;else if(d[i].close<d[i-1].close)obv-=d[i].volume;}return obv;}

function calcVWAP(d){let cumVol=0,cumTP=0;for(const c of d){const tp=(c.high+c.low+c.close)/3;cumVol+=c.volume;cumTP+=tp*c.volume;}return cumVol===0?0:cumTP/cumVol;}

function calcATR(d,p=14){if(d.length<p+1)return null;const trs=[];for(let i=1;i<d.length;i++){const tr=Math.max(d[i].high-d[i].low,Math.abs(d[i].high-d[i-1].close),Math.abs(d[i].low-d[i-1].close));trs.push(tr);}let atr=trs.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<trs.length;i++)atr=(atr*(p-1)+trs[i])/p;return atr;}

function calcWilliamsR(d,p=14){if(d.length<p)return null;const last=d.slice(-p);const hh=Math.max(...last.map(c=>c.high));const ll=Math.min(...last.map(c=>c.low));const close=d[d.length-1].close;return hh===ll?-50:((hh-close)/(hh-ll))*-100;}

/* ───── 이치모쿠 클라우드 계산 ───── */
function calcIchimoku(d,tenkanP=9,kijunP=26,senkouBP=52,displacement=26){
    const hl=(arr,p,i)=>{const s=arr.slice(Math.max(0,i-p+1),i+1);return{h:Math.max(...s.map(x=>x.high)),l:Math.min(...s.map(x=>x.low))};};
    const tenkan=[],kijun=[],senkouA=[],senkouB=[];
    for(let i=0;i<d.length;i++){
        if(i>=tenkanP-1){const{h,l}=hl(d,tenkanP,i);tenkan.push({time:d[i].time,value:(h+l)/2});}
        if(i>=kijunP-1){const{h,l}=hl(d,kijunP,i);kijun.push({time:d[i].time,value:(h+l)/2});}
    }
    for(let i=0;i<Math.min(tenkan.length,kijun.length);i++){
        const tIdx=tenkan.length-1-i,kIdx=kijun.length-1-i;
        const sa=(tenkan[tenkan.length-1-i].value+kijun[kijun.length-1-i].value)/2;
        senkouA.unshift({time:tenkan[tenkan.length-1-i].time,value:sa});
    }
    for(let i=senkouBP-1;i<d.length;i++){
        const{h,l}=hl(d,senkouBP,i);
        senkouB.push({time:d[i].time,value:(h+l)/2});
    }
    return{tenkan,kijun,senkouA:senkouA.slice(-200),senkouB:senkouB.slice(-200)};
}

/* ───── 피보나치 되돌림 계산 ───── */
function calcFibonacci(d){
    if(d.length<20)return[];
    const recent=d.slice(-100);
    let hi=-Infinity,lo=Infinity,hiIdx=0,loIdx=0;
    for(let i=0;i<recent.length;i++){
        if(recent[i].high>hi){hi=recent[i].high;hiIdx=i;}
        if(recent[i].low<lo){lo=recent[i].low;loIdx=i;}
    }
    const diff=hi-lo;
    const isUptrend=loIdx<hiIdx;
    const levels=[0,0.236,0.382,0.5,0.618,0.786,1.0];
    return levels.map(l=>({
        level:l,
        price:isUptrend?hi-diff*l:lo+diff*l,
        label:`${(l*100).toFixed(1)}%`
    }));
}

/* ───── 하모닉 패턴 ───── */
function findPivots(d,l=5,r=5){const h=[],lo=[];for(let i=l;i<d.length-r;i++){let ih=true,il=true;for(let j=i-l;j<=i+r;j++){if(j===i)continue;if(d[j].high>=d[i].high)ih=false;if(d[j].low<=d[i].low)il=false;}if(ih)h.push({idx:i,price:d[i].high,time:d[i].time,type:'H'});if(il)lo.push({idx:i,price:d[i].low,time:d[i].time,type:'L'});}return{highs:h,lows:lo};}

function detectHarmonic(d){
    if(d.length<30)return null;
    const{highs,lows}=findPivots(d,5,5);
    const pvts=[...highs,...lows].sort((a,b)=>a.idx-b.idx);
    if(pvts.length<5)return null;
    const patterns=[
        {name:'BAT',ab:[.35,.55],xd:[.75,.95]},
        {name:'Gartley',ab:[.55,.70],xd:[.70,.85]},
        {name:'Butterfly',ab:[.70,.85],xd:[1.20,1.62]},
        {name:'Crab',ab:[.35,.65],xd:[1.50,1.70]},
    ];
    for(let i=pvts.length-5;i>=Math.max(0,pvts.length-10);i--){
        const pts=pvts.slice(i,i+5);if(pts.length<5)continue;
        const[X,A,B,C,D]=pts;
        const XA=Math.abs(A.price-X.price);if(XA===0)continue;
        const abR=Math.abs(B.price-A.price)/XA;
        const xdR=Math.abs(D.price-X.price)/XA;
        for(const p of patterns){
            if(abR>=p.ab[0]&&abR<=p.ab[1]&&xdR>=p.xd[0]&&xdR<=p.xd[1]){
                return{name:p.name,points:{X,A,B,C,D},ratios:{AB:abR.toFixed(3),XD:xdR.toFixed(3)},bullish:D.type==='L'};
            }
        }
    }
    return null;
}

/* ═══════════════════════════════════
   Chart.js 기본 설정
   ═══════════════════════════════════ */
Chart.defaults.color=TX;Chart.defaults.borderColor=GR;Chart.defaults.font.size=10;
const dso={grid:{color:GR},ticks:{color:TX,maxTicksLimit:8}};

/* ═══════════════════════════════════
   TradingView 캔들차트 + MA + 이치모쿠 + 피보나치
   ═══════════════════════════════════ */
async function initTVChart(){
    const c=document.getElementById('tvChart');c.innerHTML='';
    tvChartObj=LightweightCharts.createChart(c,{
        layout:{background:{color:'#1c2333'},textColor:TX,fontSize:14},
        grid:{vertLines:{color:GR},horzLines:{color:GR}},
        crosshair:{mode:LightweightCharts.CrosshairMode.Normal},
        rightPriceScale:{borderColor:'#30363d',fontSize:14},
        timeScale:{borderColor:'#30363d',timeVisible:true,secondsVisible:false},
        localization:{timeFormatter:(t)=>{const d=new Date(t*1000);return d.toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});}},
        width:c.clientWidth,height:450,
    });
    candleSeries=tvChartObj.addCandlestickSeries({upColor:G,downColor:R,borderUpColor:G,borderDownColor:R,wickUpColor:G,wickDownColor:R});
    volumeSeries=tvChartObj.addHistogramSeries({priceFormat:{type:'volume'},priceScaleId:'vol'});
    tvChartObj.priceScale('vol').applyOptions({scaleMargins:{top:0.87,bottom:0}});
    for(const p of MA_P)maSeries[p]=tvChartObj.addLineSeries({color:MA_C[p],lineWidth:1,priceLineVisible:false,lastValueVisible:false});
    // 이치모쿠 시리즈
    ichimokuTenkan=tvChartObj.addLineSeries({color:'#22d3ee',lineWidth:1,priceLineVisible:false,lastValueVisible:false});
    ichimokuKijun=tvChartObj.addLineSeries({color:'#ec4899',lineWidth:1,priceLineVisible:false,lastValueVisible:false});
    ichimokuSenkouA=tvChartObj.addLineSeries({color:'rgba(0,210,106,0.4)',lineWidth:1,priceLineVisible:false,lastValueVisible:false});
    ichimokuSenkouB=tvChartObj.addLineSeries({color:'rgba(255,71,87,0.4)',lineWidth:1,priceLineVisible:false,lastValueVisible:false});
    // 청산물량 버블 (롱청산=초록 원, 숏청산=빨강 원 — 캔들차트 위에 마커로 표시)
    liqBubbleSeries=null; // 마커 기반이므로 별도 시리즈 불필요
    window.addEventListener('resize',()=>{if(tvChartObj)tvChartObj.applyOptions({width:c.clientWidth});});
}

async function updateTVChart(){
    try{
        const d=await bybitKline(currentSymbol,currentInterval,500);
        if(!d.length)return;
        lastKlineData=d;
        candleSeries.setData(d);
        volumeSeries.setData(d.map(x=>({time:x.time,value:x.volume,color:x.close>=x.open?'rgba(0,210,106,0.25)':'rgba(255,71,87,0.25)'})));

        // MA
        const leg=[];
        for(const p of MA_P){const ma=calcSMA(d,p);maSeries[p].setData(ma);if(ma.length)leg.push(`<span style="color:${MA_C[p]}">MA${p}:${fp(ma[ma.length-1].value)}</span>`);}
        document.getElementById('maLegend').innerHTML=leg.join(' | ');

        // 이치모쿠
        const ich=calcIchimoku(d);
        ichimokuTenkan.setData(ich.tenkan);
        ichimokuKijun.setData(ich.kijun);
        ichimokuSenkouA.setData(ich.senkouA);
        ichimokuSenkouB.setData(ich.senkouB);

        // 피보나치 되돌림 — 가격선으로 표시
        fibLines.forEach(l=>{try{tvChartObj.removeSeries(l);}catch(e){}});
        fibLines=[];
        const fibs=calcFibonacci(d);
        const fibColors=['#888','#f0b90b','#00d26a','#58a6ff','#a855f7','#ec4899','#888'];
        fibs.forEach((f,i)=>{
            const s=tvChartObj.addLineSeries({color:fibColors[i]||'#555',lineWidth:1,lineStyle:2,priceLineVisible:false,lastValueVisible:true,title:`Fib ${f.label}`});
            const startTime=d[Math.max(0,d.length-100)].time;
            const endTime=d[d.length-1].time;
            s.setData([{time:startTime,value:f.price},{time:endTime,value:f.price}]);
            fibLines.push(s);
        });

        // RSI, MACD
        updateRSIChart(d);
        updateMACDChart(d);
        // 하모닉
        detectAndShowHarmonics(d);
        // 지표 패널
        updateIndicatorPanels(d);
        // 저항선/지지선
        drawSupportResistance(d);
        // 청산물량 히트맵 바 (버블 제외)
        updateLiqLevels();
        // CME 갭 표시
        updateCMEGaps();
        // 차트패턴 감지 + 롱/숏 신호 + 타점 화살표
        generateTradeSignal(d);

        if(!tvChartObj._fitted){tvChartObj.timeScale().fitContent();tvChartObj._fitted=true;}
    }catch(e){console.error('Chart error:',e);}
}

/* ───── RSI 차트 ───── */
function initRSIChart(){
    const c=document.getElementById('rsiChart');c.innerHTML='';
    rsiChartObj=LightweightCharts.createChart(c,{layout:{background:{color:'#1c2333'},textColor:TX},grid:{vertLines:{color:GR},horzLines:{color:GR}},rightPriceScale:{borderColor:'#30363d'},timeScale:{borderColor:'#30363d',visible:false},width:c.clientWidth,height:140});
    rsiLine=rsiChartObj.addLineSeries({color:'#a855f7',lineWidth:2,priceLineVisible:false});
    window.addEventListener('resize',()=>{if(rsiChartObj)rsiChartObj.applyOptions({width:c.clientWidth});});
}
function updateRSIChart(d){const r=calcRSI(d,14);if(r.length)rsiLine.setData(r);}

/* ───── MACD 차트 ───── */
function initMACDChart(){
    const c=document.getElementById('macdChart');c.innerHTML='';
    macdChartObj=LightweightCharts.createChart(c,{layout:{background:{color:'#1c2333'},textColor:TX},grid:{vertLines:{color:GR},horzLines:{color:GR}},rightPriceScale:{borderColor:'#30363d'},timeScale:{borderColor:'#30363d',visible:false},width:c.clientWidth,height:140});
    macdHist=macdChartObj.addHistogramSeries({priceLineVisible:false,lastValueVisible:false});
    macdLine=macdChartObj.addLineSeries({color:BL,lineWidth:2,priceLineVisible:false,lastValueVisible:false});
    macdSignal=macdChartObj.addLineSeries({color:'#ff9f43',lineWidth:1,priceLineVisible:false,lastValueVisible:false});
    window.addEventListener('resize',()=>{if(macdChartObj)macdChartObj.applyOptions({width:c.clientWidth});});
}
function updateMACDChart(d){const m=calcMACD(d);if(m.macd.length){macdHist.setData(m.hist);macdLine.setData(m.macd);macdSignal.setData(m.signal);}}

/* ───── 하모닉 패턴 ───── */
function detectAndShowHarmonics(d){
    const el=document.getElementById('harmonicInfo');
    const p=detectHarmonic(d);
    if(p){
        const dir=p.bullish?'강세(Bullish)':'약세(Bearish)';
        el.innerHTML=`<span class="pattern-found">${p.name} 패턴 감지! (${dir})</span> AB=${p.ratios.AB} XD=${p.ratios.XD} | X=${fp(p.points.X.price)} → D=${fp(p.points.D.price)}`;
        candleSeries.setMarkers(Object.entries(p.points).map(([n,pt])=>({time:pt.time,position:pt.type==='H'?'aboveBar':'belowBar',color:'#ff9f43',shape:'circle',text:n})));
    }else{
        el.innerHTML='하모닉 패턴: 현재 감지된 패턴 없음';
        candleSeries.setMarkers([]);
    }
}

/* ═══════════════════════════════════
   저항선/지지선 감지 + 굵기 표시
   ═══════════════════════════════════ */
let srLines=[];
function drawSupportResistance(d){
    srLines.forEach(s=>{try{tvChartObj.removeSeries(s);}catch(e){}});
    srLines=[];
    if(d.length<30)return;

    // 피벗 기반 지지/저항 레벨 찾기
    const pvts=findPivots(d,5,5);
    const price=d[d.length-1].close;
    const tolerance=price*0.003; // 0.3% 이내 = 같은 레벨 (더 세밀하게)

    // 레벨 클러스터링 — 가까운 피벗끼리 그룹핑
    const allLevels=[];
    pvts.highs.forEach(h=>allLevels.push({price:h.price,type:'R',time:h.time}));
    pvts.lows.forEach(l=>allLevels.push({price:l.price,type:'S',time:l.time}));
    allLevels.sort((a,b)=>a.price-b.price);

    const clusters=[];
    for(const lv of allLevels){
        let found=false;
        for(const c of clusters){
            if(Math.abs(c.price-lv.price)<tolerance){
                c.touches++;
                c.price=(c.price*(c.touches-1)+lv.price)/c.touches; // 평균가
                found=true;
                break;
            }
        }
        if(!found)clusters.push({price:lv.price,touches:1,type:lv.price>price?'R':'S'});
    }

    // 터치 2회 이상만 유의미, 저항선3개+지지선3개 균형 표시
    const resistances=clusters.filter(c=>c.touches>=2&&c.price>price).sort((a,b)=>b.touches-a.touches).slice(0,3);
    const supports=clusters.filter(c=>c.touches>=2&&c.price<=price).sort((a,b)=>b.touches-a.touches).slice(0,3);
    const significant=[...resistances,...supports];
    const startT=d[Math.max(0,d.length-100)].time, endT=d[d.length-1].time;

    significant.forEach(c=>{
        const isRes=c.price>price;
        const width=Math.min(4,c.touches); // 터치 횟수=선 굵기 (1~4)
        const color=isRes?'rgba(255,71,87,0.6)':'rgba(0,210,106,0.6)';
        const s=tvChartObj.addLineSeries({
            color:color,lineWidth:width,lineStyle:0,
            priceLineVisible:false,lastValueVisible:true,
            title:`${isRes?'R':'S'}(${c.touches})`
        });
        s.setData([{time:startT,value:c.price},{time:endT,value:c.price}]);
        srLines.push(s);
    });
}

/* ═══════════════════════════════════
   CME 갭 표시
   ═══════════════════════════════════ */
let cmeGapLines=[];
async function updateCMEGaps(){
    try{
        const gaps=await fetchCMEGaps(currentSymbol);
        // 이전 갭 라인 제거
        cmeGapLines.forEach(s=>{try{tvChartObj.removeSeries(s);}catch(e){}});
        cmeGapLines=[];
        const el=document.getElementById('cmeGapInfo');
        if(!gaps.length){el.innerHTML='CME 갭: 감지된 갭 없음';return;}

        const recent=gaps.slice(-5); // 최근 5개만
        let html='CME 갭: ';
        recent.forEach(g=>{
            const color=g.gap>0?G:R;
            const status=g.filled?'✅필링':'⬜미필링';
            html+=`<span style="color:${color};margin-right:12px;">${g.gap>0?'▲':'▼'}$${Math.abs(g.gap).toLocaleString()} (${g.gap_pct>0?'+':''}${g.gap_pct}%) ${status}</span>`;

            // 차트에 갭 영역 표시 (두 개의 수평선)
            if(!g.filled){
                const s1=tvChartObj.addLineSeries({color:color,lineWidth:1,lineStyle:1,priceLineVisible:false,lastValueVisible:true,title:`CME Gap ${g.gap>0?'▲':'▼'}`});
                const kd=lastKlineData;
                if(kd.length>1){
                    s1.setData([{time:g.time,value:g.prev_close},{time:kd[kd.length-1].time,value:g.prev_close}]);
                    cmeGapLines.push(s1);
                    const s2=tvChartObj.addLineSeries({color:color,lineWidth:1,lineStyle:1,priceLineVisible:false,lastValueVisible:false});
                    s2.setData([{time:g.time,value:g.gap_open},{time:kd[kd.length-1].time,value:g.gap_open}]);
                    cmeGapLines.push(s2);
                }
            }
        });
        el.innerHTML=html;
    }catch(e){}
}

/* ═══════════════════════════════════
   유튜버 기법: RSI 다이버전스 + 와이코프 + 오더블록 + FVG + 유동성스윕
   (코인의 바이블 / 비트코인 일루미나티 스타일)
   ═══════════════════════════════════ */
function detectRSIDivergence(d,rsiData){
    const signals=[];
    if(rsiData.length<20)return signals;
    // 최근 30봉 내에서 다이버전스 검색
    const lookback=Math.min(30,rsiData.length-1);
    for(let i=rsiData.length-1;i>=rsiData.length-lookback&&i>=1;i--){
        const pIdx=d.findIndex(c=>c.time===rsiData[i].time);
        if(pIdx<10)continue;
        // 이전 저점 찾기 (10봉 전)
        const prevP=d.slice(Math.max(0,pIdx-15),pIdx);
        const prevR=rsiData.slice(Math.max(0,i-15),i);
        if(!prevP.length||!prevR.length)continue;
        const prevLow=Math.min(...prevP.map(c=>c.low));
        const prevRsiLow=Math.min(...prevR.map(r=>r.value));
        // 상승 다이버전스: 가격 저점 갱신 + RSI 저점 미갱신
        if(d[pIdx].low<=prevLow*1.001&&rsiData[i].value>prevRsiLow+2){
            signals.push({type:'bullish_div',time:d[pIdx].time,strength:75});break;
        }
        const prevHigh=Math.max(...prevP.map(c=>c.high));
        const prevRsiHigh=Math.max(...prevR.map(r=>r.value));
        // 하락 다이버전스
        if(d[pIdx].high>=prevHigh*0.999&&rsiData[i].value<prevRsiHigh-2){
            signals.push({type:'bearish_div',time:d[pIdx].time,strength:75});break;
        }
    }
    return signals;
}

function detectOrderBlocks(d){
    const blocks=[];
    for(let i=1;i<d.length-1;i++){
        // 상승 오더블록: 음봉 뒤 강한 양봉이 고점 돌파
        if(d[i].close<d[i].open&&d[i+1].close>d[i+1].open&&d[i+1].close>d[i].high){
            blocks.push({type:'bullish_ob',price:d[i].close,time:d[i].time,high:d[i].open});
        }
        // 하락 오더블록
        if(d[i].close>d[i].open&&d[i+1].close<d[i+1].open&&d[i+1].close<d[i].low){
            blocks.push({type:'bearish_ob',price:d[i].close,time:d[i].time,low:d[i].open});
        }
    }
    return blocks.slice(-5); // 최근 5개
}

function detectFVG(d){
    const fvgs=[];
    for(let i=2;i<d.length;i++){
        // 상승 FVG: 1번째 고가 < 3번째 저가
        if(d[i].low>d[i-2].high){
            fvgs.push({type:'bullish_fvg',top:d[i].low,bottom:d[i-2].high,time:d[i].time});
        }
        // 하락 FVG
        if(d[i].high<d[i-2].low){
            fvgs.push({type:'bearish_fvg',top:d[i-2].low,bottom:d[i].high,time:d[i].time});
        }
    }
    return fvgs.slice(-3);
}

function detectLiquiditySweep(d,lookback=20){
    const sweeps=[];
    for(let i=lookback;i<d.length;i++){
        const prevHigh=Math.max(...d.slice(i-lookback,i).map(c=>c.high));
        const prevLow=Math.min(...d.slice(i-lookback,i).map(c=>c.low));
        // 고점 스윕 후 하락 (숏 신호)
        if(d[i].high>prevHigh&&d[i].close<prevHigh&&d[i].close<d[i].open){
            sweeps.push({type:'bearish_sweep',time:d[i].time,level:prevHigh});
        }
        // 저점 스윕 후 상승 (롱 신호)
        if(d[i].low<prevLow&&d[i].close>prevLow&&d[i].close>d[i].open){
            sweeps.push({type:'bullish_sweep',time:d[i].time,level:prevLow});
        }
    }
    return sweeps.slice(-3);
}

function detectWyckoff(d){
    // 와이코프 VSA: 높은거래량+좁은스프레드=축적/분배 신호
    if(d.length<25)return[];
    const signals=[];
    const volMA=d.slice(-20).reduce((s,c)=>s+c.volume,0)/20;
    const spreadMA=d.slice(-20).reduce((s,c)=>s+(c.high-c.low),0)/20;
    const last=d[d.length-1];
    const spread=last.high-last.low;
    const closePos=(last.close-last.low)/Math.max(spread,0.0001);
    // 스프링: 높은거래량+좁은스프레드+종가 고점근처
    if(last.volume>volMA*1.5&&spread<spreadMA*0.7&&closePos>0.7){
        signals.push({type:'wyckoff_spring',strength:60});
    }
    // 업스러스트: 높은거래량+좁은스프레드+종가 저점근처
    if(last.volume>volMA*1.5&&spread<spreadMA*0.7&&closePos<0.3){
        signals.push({type:'wyckoff_upthrust',strength:60});
    }
    return signals;
}

/* ═══════════════════════════════════
   차트 패턴 감지 엔진 + 롱/숏 신호 시스템
   ═══════════════════════════════════ */
function detectChartPatterns(d){
    const patterns=[];
    if(d.length<30)return patterns;

    const pvts=findPivots(d,5,5);
    const highs=pvts.highs, lows=pvts.lows;
    const price=d[d.length-1].close;
    const recent=d.slice(-50);

    // 1) 더블바텀 (강세)
    if(lows.length>=2){
        const l1=lows[lows.length-2],l2=lows[lows.length-1];
        const diff=Math.abs(l1.price-l2.price)/l1.price;
        if(diff<0.02&&l2.idx-l1.idx>=5&&l2.idx-l1.idx<=40){
            patterns.push({name:'더블 바텀',type:'long',strength:80,desc:'지지선 2회 터치 후 반등'});
        }
    }
    // 2) 더블탑 (약세)
    if(highs.length>=2){
        const h1=highs[highs.length-2],h2=highs[highs.length-1];
        const diff=Math.abs(h1.price-h2.price)/h1.price;
        if(diff<0.02&&h2.idx-h1.idx>=5&&h2.idx-h1.idx<=40){
            patterns.push({name:'더블 톱',type:'short',strength:80,desc:'저항선 2회 터치 후 하락'});
        }
    }
    // 3) Higher High & Higher Low (강세 구조)
    if(highs.length>=2&&lows.length>=2){
        const hh=highs[highs.length-1].price>highs[highs.length-2].price;
        const hl=lows[lows.length-1].price>lows[lows.length-2].price;
        if(hh&&hl)patterns.push({name:'HH & HL (상승 구조)',type:'long',strength:60,desc:'고점과 저점 모두 높아지는 중'});
    }
    // 4) Lower High & Lower Low (약세 구조)
    if(highs.length>=2&&lows.length>=2){
        const lh=highs[highs.length-1].price<highs[highs.length-2].price;
        const ll=lows[lows.length-1].price<lows[lows.length-2].price;
        if(lh&&ll)patterns.push({name:'LH & LL (하락 구조)',type:'short',strength:60,desc:'고점과 저점 모두 낮아지는 중'});
    }
    // 5) 상승 삼각형 (저점 상승 + 수평 저항)
    if(highs.length>=3&&lows.length>=3){
        const topFlat=Math.abs(highs[highs.length-1].price-highs[highs.length-3].price)/highs[highs.length-1].price<0.01;
        const botRise=lows[lows.length-1].price>lows[lows.length-3].price;
        if(topFlat&&botRise)patterns.push({name:'상승 삼각형',type:'long',strength:70,desc:'저점 상승 + 수평 저항선'});
    }
    // 6) 하강 삼각형
    if(highs.length>=3&&lows.length>=3){
        const botFlat=Math.abs(lows[lows.length-1].price-lows[lows.length-3].price)/lows[lows.length-1].price<0.01;
        const topFall=highs[highs.length-1].price<highs[highs.length-3].price;
        if(botFlat&&topFall)patterns.push({name:'하강 삼각형',type:'short',strength:70,desc:'고점 하락 + 수평 지지선'});
    }
    // 7) 불 플래그 (급등 후 하락 채널 → 돌파)
    if(d.length>=20){
        const impulse=d.slice(-20,-10);
        const flag=d.slice(-10);
        const impRise=(impulse[impulse.length-1].close-impulse[0].close)/impulse[0].close;
        const flagDip=(flag[flag.length-1].close-flag[0].close)/flag[0].close;
        if(impRise>0.03&&flagDip<0&&flagDip>-0.02)patterns.push({name:'불 플래그',type:'long',strength:65,desc:'급등 후 눌림목 형성'});
    }
    // 8) 베어 플래그
    if(d.length>=20){
        const impulse=d.slice(-20,-10);
        const flag=d.slice(-10);
        const impFall=(impulse[impulse.length-1].close-impulse[0].close)/impulse[0].close;
        const flagBounce=(flag[flag.length-1].close-flag[0].close)/flag[0].close;
        if(impFall<-0.03&&flagBounce>0&&flagBounce<0.02)patterns.push({name:'베어 플래그',type:'short',strength:65,desc:'급락 후 약한 반등'});
    }
    // 9) V-반전 (강세)
    if(d.length>=10){
        const seg=d.slice(-10);
        const mid=Math.floor(seg.length/2);
        const firstHalf=seg.slice(0,mid),secondHalf=seg.slice(mid);
        const drop=(firstHalf[firstHalf.length-1].low-firstHalf[0].close)/firstHalf[0].close;
        const rise=(secondHalf[secondHalf.length-1].close-secondHalf[0].low)/secondHalf[0].low;
        if(drop<-0.03&&rise>0.03)patterns.push({name:'V-반전 (강세)',type:'long',strength:55,desc:'급락 후 급반등'});
    }
    // 10) 지지/저항 돌파
    if(d.length>=50){
        const prev20High=Math.max(...d.slice(-50,-5).map(c=>c.high));
        const prev20Low=Math.min(...d.slice(-50,-5).map(c=>c.low));
        if(price>prev20High)patterns.push({name:'저항선 돌파',type:'long',strength:70,desc:'최근 고점 돌파'});
        if(price<prev20Low)patterns.push({name:'지지선 붕괴',type:'short',strength:70,desc:'최근 저점 하향 이탈'});
    }

    return patterns;
}

function generateTradeSignal(d){
    if(d.length<30)return;
    const price=d[d.length-1].close;
    let longScore=0,shortScore=0;
    const reasons=[];

    // 1) 차트 패턴 신호
    const patterns=detectChartPatterns(d);
    patterns.forEach(p=>{
        if(p.type==='long')longScore+=p.strength;
        else shortScore+=p.strength;
        reasons.push(`${p.type==='long'?'🟢':'🔴'} ${p.name}`);
    });

    // 2) RSI 신호
    const rsi=calcRSI(d,14);
    if(rsi.length){
        const rv=rsi[rsi.length-1].value;
        if(rv<30){longScore+=40;reasons.push('🟢 RSI 과매도('+rv.toFixed(0)+')');}
        else if(rv<40){longScore+=15;reasons.push('🟢 RSI 약세구간('+rv.toFixed(0)+')');}
        else if(rv>70){shortScore+=40;reasons.push('🔴 RSI 과매수('+rv.toFixed(0)+')');}
        else if(rv>60){shortScore+=15;reasons.push('🔴 RSI 강세과열('+rv.toFixed(0)+')');}
    }

    // 3) MACD 신호
    const macd=calcMACD(d);
    if(macd.hist.length>=2){
        const h1=macd.hist[macd.hist.length-2].value;
        const h2=macd.hist[macd.hist.length-1].value;
        if(h1<0&&h2>0){longScore+=50;reasons.push('🟢 MACD 골든크로스');}
        if(h1>0&&h2<0){shortScore+=50;reasons.push('🔴 MACD 데드크로스');}
        if(h2>0&&h2>h1){longScore+=10;reasons.push('🟢 MACD 히스토그램↑');}
        if(h2<0&&h2<h1){shortScore+=10;reasons.push('🔴 MACD 히스토그램↓');}
    }

    // 4) MA 배열 신호
    const ma7=calcSMA(d,7),ma20=calcSMA(d,20),ma100=calcSMA(d,100);
    if(ma7.length&&ma20.length&&ma100.length){
        const m7=ma7[ma7.length-1].value,m20=ma20[ma20.length-1].value,m100=ma100[ma100.length-1].value;
        if(price>m7&&m7>m20&&m20>m100){longScore+=30;reasons.push('🟢 MA 정배열');}
        if(price<m7&&m7<m20&&m20<m100){shortScore+=30;reasons.push('🔴 MA 역배열');}
        if(price>m7&&price<m20){reasons.push('⚪ MA7 위, MA20 아래');}
    }

    // 5) 거래량 확인
    if(d.length>=20){
        const avgVol=d.slice(-20,-1).reduce((s,c)=>s+c.volume,0)/19;
        const lastVol=d[d.length-1].volume;
        if(lastVol>avgVol*1.5){
            if(d[d.length-1].close>d[d.length-1].open){longScore+=20;reasons.push('🟢 거래량 급증+양봉');}
            else{shortScore+=20;reasons.push('🔴 거래량 급증+음봉');}
        }
    }

    // 6) CCI
    const cci=calcCCI(d,20);
    if(cci!==null){
        if(cci<-100){longScore+=15;reasons.push('🟢 CCI 과매도');}
        if(cci>100){shortScore+=15;reasons.push('🔴 CCI 과매수');}
    }

    // 7) Williams %R
    const wr=calcWilliamsR(d,14);
    if(wr!==null){
        if(wr<-80){longScore+=15;reasons.push('🟢 W%R 과매도');}
        if(wr>-20){shortScore+=15;reasons.push('🔴 W%R 과매수');}
    }

    // 8) RSI 다이버전스 (코인의 바이블 기법)
    const rsiDiv=detectRSIDivergence(d,rsi);
    rsiDiv.forEach(s=>{
        if(s.type==='bullish_div'){longScore+=s.strength;reasons.push('🟢 RSI 상승다이버전스');}
        if(s.type==='bearish_div'){shortScore+=s.strength;reasons.push('🔴 RSI 하락다이버전스');}
    });

    // 9) 유동성 스윕 (비트코인 일루미나티 기법)
    const sweeps=detectLiquiditySweep(d,20);
    if(sweeps.length){
        const last=sweeps[sweeps.length-1];
        if(last.type==='bullish_sweep'&&d[d.length-1].time-last.time<86400*3){
            longScore+=50;reasons.push('🟢 저점 유동성스윕(반전)');}
        if(last.type==='bearish_sweep'&&d[d.length-1].time-last.time<86400*3){
            shortScore+=50;reasons.push('🔴 고점 유동성스윕(반전)');}
    }

    // 10) 와이코프 VSA
    const wyckoff=detectWyckoff(d);
    wyckoff.forEach(w=>{
        if(w.type==='wyckoff_spring'){longScore+=w.strength;reasons.push('🟢 와이코프 스프링(축적)');}
        if(w.type==='wyckoff_upthrust'){shortScore+=w.strength;reasons.push('🔴 와이코프 업스러스트(분배)');}
    });

    // 11) FVG (비트코인 일루미나티 기법)
    const fvgs=detectFVG(d);
    if(fvgs.length){
        const last=fvgs[fvgs.length-1];
        const p=d[d.length-1].close;
        if(last.type==='bullish_fvg'&&p<=last.top&&p>=last.bottom){
            longScore+=40;reasons.push('🟢 상승 FVG 영역 진입');}
        if(last.type==='bearish_fvg'&&p>=last.bottom&&p<=last.top){
            shortScore+=40;reasons.push('🔴 하락 FVG 영역 진입');}
    }

    // UI 업데이트
    const dirEl=document.getElementById('signalDirection');
    const scoreEl=document.getElementById('signalScore');
    const reasonEl=document.getElementById('signalReasons');
    const patternEl=document.getElementById('patternInfo');

    const net=longScore-shortScore;
    if(net>50){
        dirEl.textContent='LONG 추천';dirEl.className='signal-badge long';
    }else if(net<-50){
        dirEl.textContent='SHORT 추천';dirEl.className='signal-badge short';
    }else if(net>20){
        dirEl.textContent='약한 LONG';dirEl.className='signal-badge long';
    }else if(net<-20){
        dirEl.textContent='약한 SHORT';dirEl.className='signal-badge short';
    }else{
        dirEl.textContent='관망';dirEl.className='signal-badge neutral';
    }
    scoreEl.textContent=`롱: ${longScore}점 | 숏: ${shortScore}점 | 순: ${net>0?'+':''}${net}`;
    // reasons에서 이모지 제거
    reasonEl.textContent=reasons.slice(0,8).map(r=>r.replace(/🟢|🔴|⚪/g,'')).join(' | ');
    patternEl.innerHTML=patterns.length?
        '패턴: '+patterns.map(p=>`<span style="color:${p.type==='long'?G:R}">${p.name} [${p.type==='long'?'롱':'숏'}신호 ${p.strength}점]</span>`).join(' | '):
        '패턴: 감지된 패턴 없음';

    // 캔들차트에 정밀 롱/숏 타점 화살표 (복합 지표 확인)
    const markers=[];
    const rsiData=calcRSI(d,14);
    const macdD=calcMACD(d);

    // MA 데이터 준비
    const ma7d=calcSMA(d,7),ma20d=calcSMA(d,20);

    for(let i=2;i<d.length;i++){
        const c=d[i],prev=d[i-1],prev2=d[i-2];
        const t=c.time;
        // 해당 시점의 RSI 찾기
        const ri=rsiData.find(r=>r.time===t);
        const riPrev=rsiData.find(r=>r.time===prev.time);
        if(!ri||!riPrev)continue;
        // 해당 시점의 MACD 찾기
        const mi=macdD.hist.find(h=>h.time===t);
        const miPrev=macdD.hist.find(h=>h.time===prev.time);
        // 해당 시점의 MA 찾기
        const m7=ma7d.find(m=>m.time===t);
        const m20=ma20d.find(m=>m.time===t);

        let longConf=0,shortConf=0;

        // === 롱 타점 조건 (3개 이상 충족 시) ===
        // 1) RSI 과매도 반등 (RSI<40에서 상승)
        if(ri.value<40&&ri.value>riPrev.value)longConf++;
        // 2) 양봉 (종가>시가)
        if(c.close>c.open)longConf++;
        // 3) 이전 봉이 음봉 (하락 후 반전)
        if(prev.close<prev.open)longConf++;
        // 4) 거래량 증가
        if(c.volume>prev.volume*1.2)longConf++;
        // 5) MACD 히스토그램 상승 전환
        if(mi&&miPrev&&mi.value>miPrev.value)longConf++;
        // 6) 가격이 MA7 위
        if(m7&&c.close>m7.value)longConf++;
        // 7) 저점 스윕 패턴 (꼬리가 몸통보다 긴 해머형)
        const body=Math.abs(c.close-c.open);
        const lowerWick=Math.min(c.open,c.close)-c.low;
        if(lowerWick>body*1.5&&c.close>c.open)longConf++;
        // 8) 지지선 근처 반등
        if(m20&&c.low<m20.value&&c.close>m20.value)longConf++;

        // === 숏 타점 조건 ===
        // 1) RSI 과매수 하락 (RSI>60에서 하락)
        if(ri.value>60&&ri.value<riPrev.value)shortConf++;
        // 2) 음봉
        if(c.close<c.open)shortConf++;
        // 3) 이전 봉이 양봉 (상승 후 반전)
        if(prev.close>prev.open)shortConf++;
        // 4) 거래량 증가
        if(c.volume>prev.volume*1.2)shortConf++;
        // 5) MACD 히스토그램 하락
        if(mi&&miPrev&&mi.value<miPrev.value)shortConf++;
        // 6) 가격이 MA7 아래
        if(m7&&c.close<m7.value)shortConf++;
        // 7) 슈팅스타 (윗꼬리가 몸통보다 긴 음봉)
        const upperWick=c.high-Math.max(c.open,c.close);
        if(upperWick>body*1.5&&c.close<c.open)shortConf++;
        // 8) 저항선 근처 거부
        if(m20&&c.high>m20.value&&c.close<m20.value)shortConf++;

        // 4개 이상 충족 = 강한 신호, 3개 = 보통 신호
        if(longConf>=4&&shortConf<3){
            const label=longConf>=5?'강롱':'롱';
            const color=longConf>=5?'#00ff88':G;
            markers.push({time:t,position:'belowBar',color:color,shape:'arrowUp',text:label});
        }
        if(shortConf>=4&&longConf<3){
            const label=shortConf>=5?'강숏':'숏';
            const color=shortConf>=5?'#ff2244':R;
            markers.push({time:t,position:'aboveBar',color:color,shape:'arrowDown',text:label});
        }
    }

    // MACD 골든/데드 크로스 (보조 신호)
    for(let i=1;i<macdD.hist.length;i++){
        const h1=macdD.hist[i-1].value,h2=macdD.hist[i].value;
        const t=macdD.hist[i].time;
        if(h1<0&&h2>0)markers.push({time:t,position:'belowBar',color:'#22d3ee',shape:'arrowUp',text:'MC롱'});
        if(h1>0&&h2<0)markers.push({time:t,position:'aboveBar',color:'#ff9f43',shape:'arrowDown',text:'MC숏'});
    }

    // 풀롱/풀숏 시그널 추가 (미래 캔들 영역)
    const fullMarkers=addFullSignalMarkers(d,markers);

    // 중복 제거 + 정렬 (풀롱/풀숏은 기존 마커 덮어씌움)
    const markerMap=new Map();
    fullMarkers.forEach(m=>{
        const k=m.time+'_'+m.position;
        const isFull=m.text&&(m.text.includes('풀롱')||m.text.includes('풀숏'));
        const existing=markerMap.get(k);
        if(!existing||isFull)markerMap.set(k,m); // 풀롱/풀숏 우선
    });
    const uniqueMarkers=[...markerMap.values()];
    uniqueMarkers.sort((a,b)=>a.time-b.time);
    candleSeries.setMarkers(uniqueMarkers.slice(-50));

    // 보조지표 hint를 실시간 롱/숏 해석으로 교체
    updateIndicatorHints(d,rsiData,macdD,cci,wr);
}

/* ═══════════════════════════════════
   보조지표 hint 실시간 해석 업데이트
   ═══════════════════════════════════ */
function updateIndicatorHints(d,rsiData,macdD,cci,wr){
    const price=d[d.length-1].close;
    const hints=document.querySelectorAll('.hint');
    // RSI hint (index 0 = RSI)
    const rsiHint=document.querySelector('#rsiChart')?.closest('.card')?.querySelector('.hint');
    if(rsiHint&&rsiData.length){
        const rv=rsiData[rsiData.length-1].value;
        if(rv<30)rsiHint.textContent=`RSI ${rv.toFixed(1)} → 과매도 구간. 반등 가능성 높음. 롱 진입 고려`;
        else if(rv<40)rsiHint.textContent=`RSI ${rv.toFixed(1)} → 약세 구간이지만 바닥 근접. 롱 준비`;
        else if(rv>70)rsiHint.textContent=`RSI ${rv.toFixed(1)} → 과매수 구간. 하락 전환 가능. 숏 진입 고려`;
        else if(rv>60)rsiHint.textContent=`RSI ${rv.toFixed(1)} → 강세 과열. 추가 상승 가능하나 주의. 숏 대기`;
        else rsiHint.textContent=`RSI ${rv.toFixed(1)} → 중립 구간. 방향 관망`;
        rsiHint.style.color=rv<40?G:rv>60?R:TX;
    }
    // MACD hint
    const macdHint=document.querySelector('#macdChart')?.closest('.card')?.querySelector('.hint');
    if(macdHint&&macdD.hist.length>=2){
        const h=macdD.hist[macdD.hist.length-1].value;
        const prev=macdD.hist[macdD.hist.length-2].value;
        if(prev<0&&h>0)macdHint.textContent='MACD 골든크로스 발생! 강한 롱 신호. 매수 진입 타이밍';
        else if(prev>0&&h<0)macdHint.textContent='MACD 데드크로스 발생! 강한 숏 신호. 매도 진입 타이밍';
        else if(h>0&&h>prev)macdHint.textContent='MACD 히스토그램 상승 중. 롱 유지 또는 추가 진입';
        else if(h<0&&h<prev)macdHint.textContent='MACD 히스토그램 하락 중. 숏 유지 또는 추가 진입';
        else if(h>0&&h<prev)macdHint.textContent='MACD 모멘텀 약화. 롱 포지션 일부 청산 고려';
        else macdHint.textContent='MACD 모멘텀 약화. 숏 포지션 일부 청산 고려';
        macdHint.style.color=h>0?G:R;
    }
    // CCI hint
    const cciHint=document.querySelector('#indCCI')?.closest('.card')?.querySelector('.hint');
    if(cciHint&&cci!==null){
        if(cci<-100)cciHint.textContent=`CCI ${cci.toFixed(0)} → 과매도. 반등 예상. 롱 진입 고려`;
        else if(cci>100)cciHint.textContent=`CCI ${cci.toFixed(0)} → 과매수. 하락 예상. 숏 진입 고려`;
        else cciHint.textContent=`CCI ${cci.toFixed(0)} → 중립 구간. 추세 전환 대기`;
        cciHint.style.color=cci<-100?G:cci>100?R:TX;
    }
    // Williams %R hint
    const wrHint=document.querySelector('#indWilliams')?.closest('.card')?.querySelector('.hint');
    if(wrHint&&wr!==null){
        if(wr<-80)wrHint.textContent=`W%R ${wr.toFixed(1)}% → 과매도. 매수 타이밍. 롱 진입`;
        else if(wr>-20)wrHint.textContent=`W%R ${wr.toFixed(1)}% → 과매수. 매도 타이밍. 숏 진입`;
        else wrHint.textContent=`W%R ${wr.toFixed(1)}% → 중립. 방향성 확인 후 진입`;
        wrHint.style.color=wr<-80?G:wr>-20?R:TX;
    }
    // OBV hint
    const obvHint=document.querySelector('#indOBV')?.closest('.card')?.querySelector('.hint');
    if(obvHint){
        const obv=calcOBV(d);
        if(obv>0&&d[d.length-1].close>d[d.length-2].close)obvHint.textContent='OBV 양수+가격상승 → 매수세 강함. 롱 유지';
        else if(obv>0&&d[d.length-1].close<d[d.length-2].close)obvHint.textContent='OBV 양수+가격하락 → 다이버전스. 반등 가능. 롱 대기';
        else if(obv<0)obvHint.textContent='OBV 음수 → 매도세 우세. 숏 유리';
        obvHint.style.color=obv>0?G:R;
    }
    // VWAP hint
    const vwapHint=document.querySelector('#indVWAP')?.closest('.card')?.querySelector('.hint');
    if(vwapHint){
        const vwap=calcVWAP(d.slice(-50));
        if(price>vwap*1.005)vwapHint.textContent=`현재가>VWAP → 강세. 롱 우세. VWAP 지지 확인 후 추가 매수`;
        else if(price<vwap*0.995)vwapHint.textContent=`현재가<VWAP → 약세. 숏 우세. VWAP 저항 확인 후 매도`;
        else vwapHint.textContent=`현재가≈VWAP → 방향 미정. 돌파 방향 확인 후 진입`;
        vwapHint.style.color=price>vwap?G:R;
    }
    // ATR hint
    const atrHint=document.querySelector('#indATR')?.closest('.card')?.querySelector('.hint');
    if(atrHint){
        const atr=calcATR(d,14);
        if(atr)atrHint.textContent=`ATR ${fp(atr)} → 손절라인: 롱 ${fp(price-atr*1.5)}, 숏 ${fp(price+atr*1.5)}`;
    }
}

/* ═══════════════════════════════════
   Coinglass 스타일 청산 히트맵 (캔들차트 위에 Canvas 오버레이)
   가격대별 원(버블) — 원 크기 = 청산 물량에 비례
   초록원=롱 청산(가격 아래), 빨강원=숏 청산(가격 위)
   + 배경 수평 히트맵 그라데이션
   ═══════════════════════════════════ */
let liqLevelChart=null;
let liqOverlayCanvas=null;

function ensureLiqOverlay(){
    const wrap=document.getElementById('tvChart');
    if(!wrap)return null;
    wrap.style.position='relative';
    let cv=document.getElementById('liqHeatmapOverlay');
    if(!cv){
        cv=document.createElement('canvas');
        cv.id='liqHeatmapOverlay';
        cv.style.cssText='position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:3;';
        wrap.appendChild(cv);
    }
    cv.width=wrap.clientWidth*2; // retina
    cv.height=wrap.clientHeight*2;
    cv.style.width=wrap.clientWidth+'px';
    cv.style.height=wrap.clientHeight+'px';
    return cv;
}

async function updateLiqLevels(){
    try{
        const d=await fetchLiquidationData(currentSymbol);
        const cv=ensureLiqOverlay();
        if(!cv||!lastKlineData.length)return;
        const ctx=cv.getContext('2d');
        ctx.clearRect(0,0,cv.width,cv.height);

        const prices=d.price_levels;
        const longLiqs=d.long_liquidations;
        const shortLiqs=d.short_liquidations;
        const curPrice=d.current_price;
        const maxLiq=Math.max(...longLiqs,...shortLiqs,1);

        // 캔들차트의 가시 가격 범위
        const recent=lastKlineData.slice(-80);
        const visHigh=Math.max(...recent.map(c=>c.high))*1.02;
        const visLow=Math.min(...recent.map(c=>c.low))*0.98;
        const range=visHigh-visLow;
        if(range<=0)return;

        // 현재가가 차트 가격범위와 일치하는지 확인 (다른 코인 데이터 혼합 방지)
        if(curPrice<visLow*0.5||curPrice>visHigh*2){return;}

        const W=cv.width, H=cv.height;
        const rightPad=W*0.06;

        // Lightweight Charts의 실제 좌표 변환 사용
        const priceScale=candleSeries.priceScale();
        const priceToY=(p)=>{
            const coord=candleSeries.priceToCoordinate(p);
            return coord!==null?coord*2:null; // retina 보정 (x2)
        };

        // 1) 배경 수평 히트맵 바 — 롱청산=현재가 아래만, 숏청산=현재가 위만
        for(let i=0;i<prices.length;i++){
            const p=prices[i];
            if(p<visLow||p>visHigh)continue;
            const lv=longLiqs[i]/maxLiq;
            const sv=shortLiqs[i]/maxLiq;
            const y=priceToY(p);
            if(y===null)continue;
            // 롱 청산 (초록) — 현재가 아래에만 표시
            if(lv>0.02&&p<curPrice){
                const barW=(lv*W*0.4);
                const alpha=Math.min(0.5,lv*0.6);
                ctx.fillStyle=`rgba(0,210,106,${alpha})`;
                ctx.fillRect(0,y-2,barW,4);
            }
            // 숏 청산 (빨강) — 현재가 위에만 표시
            if(sv>0.02&&p>curPrice){
                const barW=(sv*W*0.4);
                const alpha=Math.min(0.5,sv*0.6);
                ctx.fillStyle=`rgba(255,71,87,${alpha})`;
                ctx.fillRect(0,y-2,barW,4);
            }
        }

        // 2) 왼쪽 Y축 청산물량 수치 라벨 (버블 제거, 라벨만 유지)
        const longPts=prices.map((p,i)=>({price:p,vol:longLiqs[i],type:'long'})).filter(x=>x.vol>5&&x.price<curPrice);
        const shortPts=prices.map((p,i)=>({price:p,vol:shortLiqs[i],type:'short'})).filter(x=>x.vol>5&&x.price>curPrice);
        longPts.sort((a,b)=>b.vol-a.vol);
        shortPts.sort((a,b)=>b.vol-a.vol);

        const drawnLabels=new Set();
        const drawLabel=(b)=>{
            if(b.price>=visLow&&b.price<=visHigh){
                const y=priceToY(b.price);
                if(y===null)return;
                const yKey=Math.round(y/30);
                if(!drawnLabels.has(yKey)){
                    drawnLabels.add(yKey);
                    ctx.font='bold 22px sans-serif';
                    ctx.textAlign='left';
                    const color=b.type==='long'?'rgba(0,210,106,0.9)':'rgba(255,71,87,0.9)';
                    ctx.fillStyle=color;
                    ctx.fillText(`${fp(b.price)} (${b.vol.toFixed(0)}%)`,10,y+4);
                }
            }
        };
        longPts.slice(0,12).forEach(drawLabel);
        shortPts.slice(0,12).forEach(drawLabel);

        // 4) 현재가 점선
        const curY=priceToY(curPrice);
        if(curY!==null){
            ctx.save();
            ctx.strokeStyle='rgba(88,166,255,0.7)';
            ctx.lineWidth=2;
            ctx.setLineDash([8,4]);
            ctx.beginPath();
            ctx.moveTo(0,curY);
            ctx.lineTo(W-rightPad,curY);
            ctx.stroke();
            ctx.restore();
        }

        // 5) CME 갭 영역 시각화 (반투명 배경)
        try{
            const gaps=await fetchCMEGaps(currentSymbol);
            gaps.filter(g=>!g.filled).forEach(g=>{
                const y1=priceToY(g.prev_close);
                const y2=priceToY(g.gap_open);
                if(y1===null||y2===null)return;
                ctx.save();
                ctx.fillStyle=g.gap>0?'rgba(0,210,106,0.08)':'rgba(255,71,87,0.08)';
                ctx.fillRect(0,Math.min(y1,y2),W-rightPad,Math.abs(y2-y1));
                ctx.strokeStyle=g.gap>0?'rgba(0,210,106,0.4)':'rgba(255,71,87,0.4)';
                ctx.lineWidth=1;ctx.setLineDash([4,4]);
                ctx.strokeRect(0,Math.min(y1,y2),W-rightPad,Math.abs(y2-y1));
                // 라벨
                ctx.fillStyle='rgba(255,255,255,0.7)';
                ctx.font='bold 14px sans-serif';ctx.textAlign='left';
                ctx.fillText(`CME GAP ${g.gap>0?'▲':'▼'}${Math.abs(g.gap_pct).toFixed(1)}%`,W*0.3,Math.min(y1,y2)+16);
                ctx.restore();
            });
        }catch(e){}

    }catch(e){console.error('LiqHeatmap error:',e);}
}

/* ═══════════════════════════════════
   지표 패널 업데이트 (CCI, OBV, VWAP, ATR, Williams%R)
   ═══════════════════════════════════ */
function updateIndicatorPanels(d){
    if(!d.length)return;
    const price=d[d.length-1].close;

    // CCI
    const cci=calcCCI(d,20);
    const cciEl=document.getElementById('indCCI');
    if(cci!==null){cciEl.textContent=cci.toFixed(1);cciEl.className='ind-value '+(cci>100?'bearish':cci<-100?'bullish':'neutral');}

    // OBV
    const obv=calcOBV(d);
    const obvEl=document.getElementById('indOBV');
    obvEl.textContent=fmt(obv);obvEl.className='ind-value '+(obv>0?'bullish':'bearish');

    // VWAP
    const vwap=calcVWAP(d.slice(-50));
    const vwapEl=document.getElementById('indVWAP');
    vwapEl.textContent=fp(vwap);vwapEl.className='ind-value '+(price>vwap?'bullish':'bearish');

    // ATR
    const atr=calcATR(d,14);
    const atrEl=document.getElementById('indATR');
    if(atr!==null){atrEl.textContent=fp(atr);atrEl.className='ind-value neutral';}

    // Williams %R
    const wr=calcWilliamsR(d,14);
    const wrEl=document.getElementById('indWilliams');
    if(wr!==null){wrEl.textContent=wr.toFixed(1)+'%';wrEl.className='ind-value '+(wr>-20?'bearish':wr<-80?'bullish':'neutral');}
}

/* ═══════════════════════════════════
   공포탐욕지수 + 풋콜비율 + 미결제약정
   ═══════════════════════════════════ */
async function updateMarketIndicators(){
    try{
        // 공포탐욕지수 (직접 호출)
        let fg;
        try{
            const fgResp=await fetch('https://api.alternative.me/fng/?limit=1');
            const fgData=await fgResp.json();
            if(fgData.data&&fgData.data[0])fg={value:parseInt(fgData.data[0].value),classification:fgData.data[0].value_classification};
            else fg={value:50,classification:'Neutral'};
        }catch(e){fg={value:50,classification:'Neutral'};}
        const fgEl=document.getElementById('indFearGreed');
        const fgTick=document.getElementById('tickFearGreed');
        fgEl.textContent=`${fg.value} (${fg.classification})`;
        fgEl.className='ind-value '+(fg.value<=25?'bullish':fg.value>=75?'bearish':'neutral');
        fgTick.textContent=`${fg.value}`;
        fgTick.className='ticker-value '+(fg.value<=40?'negative':fg.value>=60?'positive':'');
        lastFearGreedValue=fg.value; // 풀롱/풀숏용 캐시
    }catch(e){}

    try{
        // 미결제약정
        const oi={list:await bybitOI(currentSymbol,'1h',50)};
        const list=oi.list||[];
        if(list.length){
            const oiEl=document.getElementById('indOI');
            const oiVal=parseFloat(list[0].openInterest);
            oiEl.textContent=fmt(oiVal)+' '+currentSymbol.replace('USDT','');
            oiEl.className='ind-value neutral';
            // 풀롱/풀숏용 OI 변동률 캐시
            if(list.length>=2){
                const oiPrev=parseFloat(list[1].openInterest);
                lastOIChange=oiPrev>0?((oiVal-oiPrev)/oiPrev*100):0;
            }
        }
    }catch(e){}

    try{
        // 풋콜비율 (롱숏비율 기반 추정)
        const ratio={list:await bybitRatio(currentSymbol,'1h',50)};
        const rlist=ratio.list||[];
        if(rlist.length){
            const buy=parseFloat(rlist[0].buyRatio);
            const sell=parseFloat(rlist[0].sellRatio);
            lastLongShortRatio={buy,sell}; // 풀롱/풀숏용 캐시
            const pcr=(sell/buy).toFixed(3);
            const pcEl=document.getElementById('indPutCall');
            pcEl.textContent=pcr;
            pcEl.className='ind-value '+(pcr>1?'bearish':pcr<0.7?'bullish':'neutral');
            // 롱숏 게이지
            const bp=buy*100,sp=sell*100;
            document.getElementById('longPct').textContent=bp.toFixed(1)+'%';
            document.getElementById('shortPct').textContent=sp.toFixed(1)+'%';
            document.getElementById('gaugeLong').style.width=bp+'%';
            document.getElementById('gaugeLong').textContent='롱 '+bp.toFixed(1)+'%';
            document.getElementById('gaugeShort').style.width=sp+'%';
            document.getElementById('gaugeShort').textContent='숏 '+sp.toFixed(1)+'%';
        }
    }catch(e){}
}

/* ═══════════════════════════════════
   시세바
   ═══════════════════════════════════ */
async function updateTicker(){
    try{
        const t=await bybitTickers(currentSymbol);
        document.getElementById('tickPrice').textContent=fp(t.lastPrice);
        const ch=parseFloat(t.price24hPcnt)*100;
        const ce=document.getElementById('tickChange');
        ce.textContent=(ch>=0?'+':'')+ch.toFixed(2)+'%';
        ce.className='ticker-value '+(ch>=0?'positive':'negative');
        document.getElementById('tickVolume').textContent=fmt(t.turnover24h,0);
        document.getElementById('tickOI').textContent=fmt(t.openInterest)+' '+currentSymbol.replace('USDT','');
        const f=parseFloat(t.fundingRate)*100;
        const fe=document.getElementById('tickFunding');
        fe.textContent=f.toFixed(4)+'%';
        fe.className='ticker-value '+(f>=0?'positive':'negative');
    }catch(e){}
}

/* ═══════════════════════════════════
   호가창
   ═══════════════════════════════════ */
async function updateOrderbook(){
    try{
        const [d,ticker]=await Promise.all([bybitOrderbook(currentSymbol),bybitTickers(currentSymbol)]);
        const curPrice=parseFloat(ticker.lastPrice||0);
        const priceChg=parseFloat(ticker.price24hPcnt||0)*100;
        const bids=d.b||[],asks=d.a||[];
        const tb=bids.slice(0,25).reverse(),ta=asks.slice(0,25);
        const prices=[...tb.map(b=>parseFloat(b[0])),...ta.map(a=>parseFloat(a[0]))];
        const bq=[...tb.map(b=>parseFloat(b[1])),...ta.map(()=>0)];
        const aq=[...tb.map(()=>0),...ta.map(a=>parseFloat(a[1]))];
        const labels=prices.map(p=>fp(p));
        if(orderbookChart){orderbookChart.data.labels=labels;orderbookChart.data.datasets[0].data=bq;orderbookChart.data.datasets[1].data=aq;orderbookChart.update('none');}
        else{const ctx=document.getElementById('orderbookChart').getContext('2d');orderbookChart=new Chart(ctx,{type:'bar',data:{labels,datasets:[{label:'매수',data:bq,backgroundColor:GD,borderColor:G,borderWidth:1},{label:'매도',data:aq,backgroundColor:RD,borderColor:R,borderWidth:1}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,position:'top',labels:{boxWidth:10}}},scales:{x:{...dso,ticks:{...dso.ticks,maxRotation:45,maxTicksLimit:8}},y:{...dso}}}});}
        // 테이블
        const c=document.getElementById('orderbookTable');
        const mx=Math.max(...tb.map(b=>parseFloat(b[1])),...ta.map(a=>parseFloat(a[1])));
        const da=[...ta].reverse().slice(0,12);
        let h='';
        for(const a of da){const p=(parseFloat(a[1])/mx*100).toFixed(0);h+=`<div class="ob-row"><div class="ob-bar-left"></div><div class="ob-price" style="color:${R}">${fp(a[0])}</div><div class="ob-bar-right"><div class="ob-fill-ask" style="width:${p}%"></div><span class="ob-qty">${fmt(parseFloat(a[1]),4)}</span></div></div>`;}
        h+=`<div class="ob-row" style="background:rgba(88,166,255,0.15);border-radius:4px;padding:5px 0;margin:3px 0;"><div></div><div class="ob-price" style="font-weight:700;font-size:14px;" id="obMidPrice" data-price="${curPrice}"></div><div></div></div>`;
        for(const b of tb.slice().reverse().slice(0,12)){const p=(parseFloat(b[1])/mx*100).toFixed(0);h+=`<div class="ob-row"><div class="ob-bar-left"><span class="ob-qty">${fmt(parseFloat(b[1]),4)}</span><div class="ob-fill-bid" style="width:${p}%"></div></div><div class="ob-price" style="color:${G}">${fp(b[0])}</div><div class="ob-bar-right"></div></div>`;}
        c.innerHTML=h;
        // 초기 현재가 렌더 (이후 WebSocket이 실시간 업데이트)
        const midEl=document.getElementById('obMidPrice');
        if(midEl){
            const chgColor=priceChg>=0?G:R;
            const chgSign=priceChg>=0?'+':'';
            midEl.style.color=chgColor;
            midEl.innerHTML=`${fp(curPrice)} <span style="font-size:11px;opacity:0.8">(${chgSign}${priceChg.toFixed(2)}%)</span>`;
        }
    }catch(e){}
}

/* ═══════════════════════════════════
   청산 히트맵 (실시간)
   ═══════════════════════════════════ */
async function updateLiquidation(){
    try{
        const d=await fetchLiquidationData(currentSymbol);
        const labels=d.price_levels.map(p=>fp(p));
        if(liqChart){liqChart.data.labels=labels;liqChart.data.datasets[0].data=d.long_liquidations;liqChart.data.datasets[1].data=d.short_liquidations;liqChart.update('none');}
        else{const ctx=document.getElementById('liqChart').getContext('2d');liqChart=new Chart(ctx,{type:'bar',data:{labels,datasets:[{label:'롱 청산',data:d.long_liquidations,backgroundColor:GD,borderColor:G,borderWidth:1},{label:'숏 청산',data:d.short_liquidations,backgroundColor:RD,borderColor:R,borderWidth:1}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,position:'top',labels:{boxWidth:10}}},scales:{x:{...dso,stacked:true,ticks:{...dso.ticks,maxRotation:45,maxTicksLimit:8}},y:{...dso,stacked:true}}}});}
        document.querySelector('#levTable tbody').innerHTML=d.leverage_markers.map(m=>`<tr><td>${m.leverage}</td><td class="green">${fp(m.long_liq_price)}</td><td class="red">${fp(m.short_liq_price)}</td></tr>`).join('');
    }catch(e){}
}

/* ═══════════════════════════════════
   거래량 급증 알람
   ═══════════════════════════════════ */
async function checkAlerts(){
    try{
        const alerts=await fetchVolumeAlerts();
        const banner=document.getElementById('alertBanner');
        const list=document.getElementById('alertList');
        if(alerts.length>0){
            banner.style.display='block';
            const top=alerts[0];
            banner.innerHTML=`⚠️ <b>${top.symbol}</b> ${top.reasons.join(' | ')} (가격: ${top.price_change>=0?'+':''}${top.price_change}%) — 총 ${alerts.length}건 감지`;
            list.innerHTML=alerts.map(a=>{
                const cls=a.price_change>=0?'positive':'negative';
                return `<div class="alert-item">
                    <span class="sym">${a.symbol}</span>
                    <span class="spike">${a.reasons[0]}</span>
                    <span class="ticker-value ${cls}" style="font-size:11px;">${a.price_change>=0?'+':''}${a.price_change}%</span>
                    <span style="color:${TX}">가격:${fp(a.price)}</span>
                    <span style="color:${TX}">거래대금:${fmt(a.turnover)}</span>
                </div>`;
            }).join('');
        }else{banner.style.display='none';list.innerHTML='<div style="color:#8b949e;font-size:11px;">급증 감지 없음. 모니터링 중...</div>';}
    }catch(e){}
}

/* ═══════════════════════════════════
   WebSocket
   ═══════════════════════════════════ */
let liqFeedItems=[],whaleFeedItems=[];
let tradeVolAccum={buy:0,sell:0,count:0}; // 1초간 체결량 누적
function connectWS(){
    if(ws){ws.close();ws=null;}
    // Bybit WebSocket에 직접 연결 (서버 프록시 우회 — Railway IP 차단 대비)
    ws=new WebSocket('wss://stream.bybit.com/v5/public/linear');
    ws.onopen=()=>{
        ws.send(JSON.stringify({op:'subscribe',args:[`orderbook.200.${currentSymbol}`,`liquidation.${currentSymbol}`,`publicTrade.${currentSymbol}`]}));
    };
    ws.onmessage=(e)=>{try{
        const m=JSON.parse(e.data);
        if(m.data){
            // 오더북 — 실시간 중간가 업데이트
            const b=m.data.b||[],a=m.data.a||[];
            if(b.length&&a.length){const mid=(parseFloat(b[0][0])+parseFloat(a[0][0]))/2;const el=document.getElementById('obMidPrice');if(el){el.textContent=fp(mid);}}
            // 실시간 체결가 → 호가창 현재가 즉시 반영
            if(m.topic&&m.topic.startsWith('publicTrade.')){
                const trades=Array.isArray(m.data)?m.data:[m.data];
                if(trades.length){
                    const lastTrade=trades[trades.length-1];
                    const tp=parseFloat(lastTrade.p||lastTrade.price||0);
                    if(tp>0){
                        const el=document.getElementById('obMidPrice');
                        if(el){
                            const prev=parseFloat(el.getAttribute('data-price')||0);
                            const color=tp>prev?G:tp<prev?R:el.style.color;
                            el.style.color=color;
                            el.textContent=fp(tp);
                            el.setAttribute('data-price',tp);
                        }
                    }
                }
                trades.forEach(t=>{
                    const sz=parseFloat(t.v||t.size||0);
                    const px=parseFloat(t.p||t.price||0);
                    const usd=sz*px;
                    const side=t.S||t.side;
                    // 대량 체결 기준: BTC 10만$+, 알트 5만$+
                    const threshold=currentSymbol==='BTCUSDT'?100000:50000;
                    if(usd>=threshold){
                        const isBuy=side==='Buy';
                        const time=new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
                        whaleFeedItems.unshift({
                            side:isBuy?'매수 (롱)':'매도 (숏)',
                            color:isBuy?G:R,
                            size:sz,price:px,usd,time
                        });
                        if(whaleFeedItems.length>20)whaleFeedItems=whaleFeedItems.slice(0,20);
                        renderWhaleFeed();
                    }
                });
            }
            // 실시간 청산 내역
            if(m.topic&&m.topic.startsWith('liquidation.')){
                const ld=m.data;
                const side=ld.side==='Buy'?'숏 청산':'롱 청산';
                const color=ld.side==='Buy'?R:G;
                const size=parseFloat(ld.size||0);
                const price=parseFloat(ld.price||0);
                const usdVal=size*price;
                const time=new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
                liqFeedItems.unshift({side,color,size,price,usdVal,time,symbol:ld.symbol||currentSymbol});
                if(liqFeedItems.length>30)liqFeedItems=liqFeedItems.slice(0,30);
                renderLiqFeed();
            }
        }
    }catch(ex){}};
    ws.onclose=()=>setTimeout(connectWS,3000);
    ws.onerror=()=>ws.close();
}
function renderLiqFeed(){
    const el=document.getElementById('liqFeed');
    if(!el||!liqFeedItems.length)return;
    el.innerHTML=liqFeedItems.map(l=>{
        const sizeStr=l.usdVal>=1000?fmt(l.usdVal)+'$':l.usdVal.toFixed(2)+'$';
        return `<div class="alert-item"><span style="color:${l.color};font-weight:700;min-width:60px;">${l.side}</span><span style="color:${TX}">${fp(l.price)}</span><span style="font-weight:600;">${fmt(l.size)} (${sizeStr})</span><span style="color:${TX};font-size:10px;">${l.time}</span></div>`;
    }).join('');
}

function renderWhaleFeed(){
    const el=document.getElementById('whaleFeed');
    if(!el||!whaleFeedItems.length)return;
    el.innerHTML=whaleFeedItems.map(w=>{
        const usdStr=w.usd>=1e6?fmt(w.usd)+'$':w.usd>=1000?(w.usd/1000).toFixed(1)+'K$':w.usd.toFixed(0)+'$';
        const icon=w.usd>=500000?'🐋':w.usd>=100000?'🐬':'🐟';
        return `<div class="alert-item"><span style="font-size:14px;">${icon}</span><span style="color:${w.color};font-weight:700;min-width:65px;">${w.side}</span><span style="color:${TX}">${fp(w.price)}</span><span style="font-weight:600;">${usdStr}</span><span style="color:${TX};font-size:10px;">${w.time}</span></div>`;
    }).join('');
}

/* ═══════════════════════════════════
   CORS 프록시 유틸
   ═══════════════════════════════════ */
const CORS_PROXY='https://api.allorigins.win/raw?url=';
async function fetchWithProxy(url){
    const r=await fetch(CORS_PROXY+encodeURIComponent(url));
    if(!r.ok)throw new Error(`Proxy HTTP ${r.status}`);
    return r.json();
}

/* ═══════════════════════════════════
   전문가 컨센서스 패널
   ═══════════════════════════════════ */
let lastFngData=null,lastSentimentData=null;
async function updateExpertConsensus(){
    try{
        // 1) 공포탐욕지수 7일 추이
        const fngResp=await fetch('https://api.alternative.me/fng/?limit=7');
        const fngData=await fngResp.json();
        const fngEl=document.getElementById('fngHistory');
        if(fngData.data&&fngData.data.length){
            lastFngData=fngData.data;
            const today=fngData.data[0];
            let html=`<div style="font-size:22px;font-weight:700;margin-bottom:6px;">${today.value} <span style="font-size:13px;font-weight:400;">(${today.value_classification})</span></div>`;
            html+='<div style="display:flex;gap:4px;align-items:flex-end;height:40px;">';
            fngData.data.slice().reverse().forEach(d=>{
                const v=parseInt(d.value);
                const color=v<=25?R:v<=45?'#ff9f43':v<=55?YL:v<=75?'#00d26a':G;
                html+=`<div style="flex:1;background:${color};height:${v*0.4}px;border-radius:2px;" title="${d.value} (${d.value_classification})"></div>`;
            });
            html+='</div><div style="font-size:9px;color:var(--text-secondary);margin-top:2px;">7일 전 → 오늘</div>';
            fngEl.innerHTML=html;
        }
    }catch(e){console.error('FNG error:',e);}

    try{
        // 2) CoinGecko 센티먼트 + 트렌딩 (CORS 지원 — 직접 호출)
        const [btcData,trending]=await Promise.all([
            fetch('https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false').then(r=>r.json()),
            fetch('https://api.coingecko.com/api/v3/search/trending').then(r=>r.json())
        ]);
        const sentEl=document.getElementById('cgSentiment');
        const trendEl=document.getElementById('cgTrending');
        if(btcData.sentiment_votes_up_percentage!=null){
            const up=btcData.sentiment_votes_up_percentage;
            const down=btcData.sentiment_votes_down_percentage||100-up;
            lastSentimentData={up,down};
            const color=up>=60?G:up<=40?R:YL;
            sentEl.innerHTML=`<div style="font-size:18px;font-weight:700;color:${color};">긍정 ${up.toFixed(1)}% / 부정 ${down.toFixed(1)}%</div>`;
            sentEl.innerHTML+=`<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin-top:4px;"><div style="width:${up}%;background:${G};"></div><div style="width:${down}%;background:${R};"></div></div>`;
        }
        if(trending.coins){
            const top5=trending.coins.slice(0,5).map(c=>c.item);
            trendEl.innerHTML='트렌딩: '+top5.map(c=>`<span style="color:${BL};margin-right:6px;">${c.symbol}</span>`).join('');
        }
    }catch(e){console.error('CoinGecko error:',e);}

    // 3) 종합 컨센서스
    try{
        const consEl=document.getElementById('consensusResult');
        const detEl=document.getElementById('consensusDetail');
        let score=50; // 기본 중립
        let factors=[];

        // 공포탐욕 (30% 가중)
        if(lastFngData&&lastFngData.length){
            const fv=parseInt(lastFngData[0].value);
            const fngScore=fv; // 0~100 (높을수록 강세)
            score=score*0.7+fngScore*0.3;
            factors.push(`FNG:${fv}`);
        }
        // CoinGecko 센티먼트 (20% 가중)
        if(lastSentimentData){
            const sentScore=lastSentimentData.up;
            score=score*0.8+sentScore*0.2;
            factors.push(`센티:${lastSentimentData.up.toFixed(0)}%`);
        }
        // 기술적 신호 (50% 가중) — 기존 signalDirection에서 추출
        const sigDir=document.getElementById('signalDirection')?.textContent||'';
        const sigScoreText=document.getElementById('signalScore')?.textContent||'';
        const netMatch=sigScoreText.match(/순: ([+-]?\d+)/);
        if(netMatch){
            const net=parseInt(netMatch[1]);
            // 점수를 0~100 범위로 변환 (-200~+200 → 0~100)
            const techScore=Math.max(0,Math.min(100,50+net/4));
            score=score*0.5+techScore*0.5;
            factors.push(`기술:${net>0?'+':''}${net}`);
        }

        let verdict,vColor;
        if(score>=70){verdict='강세 (BULLISH)';vColor=G;}
        else if(score>=58){verdict='약한 강세';vColor='#00d26a';}
        else if(score>=42){verdict='중립';vColor=YL;}
        else if(score>=30){verdict='약한 약세';vColor='#ff9f43';}
        else{verdict='약세 (BEARISH)';vColor=R;}

        consEl.textContent=verdict;
        consEl.style.color=vColor;
        detEl.textContent=`종합: ${score.toFixed(0)}점 | ${factors.join(' | ')}`;
    }catch(e){}
}

/* ═══════════════════════════════════
   매크로 (블룸버그 스타일) 데이터
   ═══════════════════════════════════ */
let macroCache={};
async function updateMacroData(){
    const symbols=[
        {id:'DX-Y.NYB',name:'DXY (달러인덱스)',inv:true},
        {id:'^TNX',name:'US10Y (미국10년물)',inv:true},
        {id:'GC=F',name:'Gold (금 선물)',inv:false},
        {id:'^GSPC',name:'S&P 500',inv:false}
    ];
    const tableEl=document.getElementById('macroTable');
    const corrEl=document.getElementById('macroCorrelation');

    const results=[];
    for(const sym of symbols){
        try{
            const url=`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym.id)}?range=2d&interval=1d`;
            const data=await fetchWithProxy(url);
            const chart=data.chart?.result?.[0];
            if(!chart)continue;
            const meta=chart.meta;
            const price=meta.regularMarketPrice||0;
            const prevClose=meta.chartPreviousClose||meta.previousClose||price;
            const change=((price-prevClose)/prevClose*100);
            results.push({...sym,price,change,prevClose});
            macroCache[sym.id]={price,change};
        }catch(e){
            results.push({...sym,price:macroCache[sym.id]?.price||0,change:macroCache[sym.id]?.change||0});
        }
    }

    // 테이블 렌더링
    let html='<table style="width:100%;border-collapse:collapse;">';
    html+='<tr style="color:var(--text-secondary);font-size:10px;"><th style="text-align:left;padding:4px;">지표</th><th style="text-align:right;padding:4px;">현재가</th><th style="text-align:right;padding:4px;">변동</th><th style="text-align:right;padding:4px;">BTC 영향</th></tr>';
    results.forEach(r=>{
        const chgColor=r.change>=0?G:R;
        const chgSign=r.change>=0?'+':'';
        const impact=r.inv?(r.change>0?'약세':'강세'):(r.change>0?'강세':'약세');
        const impColor=impact==='강세'?G:R;
        html+=`<tr style="border-top:1px solid var(--border);">
            <td style="padding:6px 4px;font-weight:600;">${r.name}</td>
            <td style="padding:6px 4px;text-align:right;">${r.price>=1000?r.price.toLocaleString('en-US',{maximumFractionDigits:2}):r.price.toFixed(4)}</td>
            <td style="padding:6px 4px;text-align:right;color:${chgColor};font-weight:600;">${chgSign}${r.change.toFixed(2)}%</td>
            <td style="padding:6px 4px;text-align:right;color:${impColor};font-weight:700;">${impact}</td>
        </tr>`;
    });
    html+='</table>';
    tableEl.innerHTML=html;

    // 상관관계 해석
    let corrHtml='';
    const bullish=[],bearish=[];
    results.forEach(r=>{
        const isBull=r.inv?(r.change<0):(r.change>0);
        if(Math.abs(r.change)>0.1){
            if(isBull)bullish.push(r);
            else bearish.push(r);
        }
    });
    if(bullish.length>bearish.length){
        corrHtml+=`<div style="color:${G};font-weight:700;font-size:16px;margin-bottom:6px;">매크로 환경: BTC 강세</div>`;
    }else if(bearish.length>bullish.length){
        corrHtml+=`<div style="color:${R};font-weight:700;font-size:16px;margin-bottom:6px;">매크로 환경: BTC 약세</div>`;
    }else{
        corrHtml+=`<div style="color:${YL};font-weight:700;font-size:16px;margin-bottom:6px;">매크로 환경: 중립</div>`;
    }
    results.forEach(r=>{
        const arrow=r.change>=0?'▲':'▼';
        const color=r.change>=0?G:R;
        const relation=r.inv?'(역상관)':'(정상관)';
        const impact=r.inv?(r.change>0?'→ BTC 하방 압력':'→ BTC 상방 지지'):(r.change>0?'→ BTC 상방 지지':'→ BTC 하방 압력');
        corrHtml+=`<div style="margin:3px 0;font-size:11px;"><span style="color:${color}">${arrow} ${r.name} ${r.change>=0?'+':''}${r.change.toFixed(2)}%</span> <span style="color:var(--text-secondary)">${relation}</span> <span style="font-weight:600;">${impact}</span></div>`;
    });
    corrEl.innerHTML=corrHtml;
}

/* ═══════════════════════════════════
   온체인 (크립토퀀트 스타일) 데이터
   ═══════════════════════════════════ */
async function updateOnchainData(){
    const netEl=document.getElementById('onchainNetwork');
    const txEl=document.getElementById('onchainTx');
    const mktEl=document.getElementById('onchainMarket');

    // 1) 네트워크 건강 (Mempool.space)
    try{
        const [hashrate,fees]=await Promise.all([
            fetch('https://mempool.space/api/v1/mining/hashrate/1m').then(r=>r.json()),
            fetch('https://mempool.space/api/v1/fees/recommended').then(r=>r.json())
        ]);
        let html='';
        if(hashrate.currentHashrate){
            const hr=hashrate.currentHashrate/1e18; // EH/s
            html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">해시레이트:</span> <span style="font-weight:700;color:${G}">${hr.toFixed(1)} EH/s</span></div>`;
        }
        if(hashrate.currentDifficulty){
            const diff=hashrate.currentDifficulty/1e12; // T
            html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">채굴 난이도:</span> <span style="font-weight:700;">${diff.toFixed(2)} T</span></div>`;
        }
        if(fees.fastestFee!=null){
            html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">수수료 (빠른):</span> <span style="font-weight:700;color:${fees.fastestFee>50?R:YL}">${fees.fastestFee} sat/vB</span></div>`;
            html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">수수료 (보통):</span> <span>${fees.halfHourFee} sat/vB</span></div>`;
            html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">수수료 (느린):</span> <span>${fees.economyFee} sat/vB</span></div>`;
        }
        netEl.innerHTML=html||'데이터 없음';
    }catch(e){netEl.innerHTML='<span style="color:var(--text-secondary)">네트워크 데이터 로딩 실패</span>';}

    // 2) 거래 활동 (Blockchain.com + Blockchair)
    try{
        const [txCount,txVol,blockchairStats]=await Promise.all([
            fetch('https://api.blockchain.info/charts/n-transactions?timespan=1days&format=json&cors=true').then(r=>r.json()).catch(()=>null),
            fetch('https://api.blockchain.info/charts/estimated-transaction-volume-usd?timespan=1days&format=json&cors=true').then(r=>r.json()).catch(()=>null),
            fetchWithProxy('https://api.blockchair.com/bitcoin/stats').catch(()=>null)
        ]);
        let html='';
        if(txCount?.values?.length){
            const v=txCount.values[txCount.values.length-1].y;
            html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">일일 거래수:</span> <span style="font-weight:700;">${fmt(v,0)}</span></div>`;
        }
        if(txVol?.values?.length){
            const v=txVol.values[txVol.values.length-1].y;
            html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">거래량 (USD):</span> <span style="font-weight:700;color:${BL}">$${fmt(v,0)}</span></div>`;
        }
        if(blockchairStats?.data){
            const s=blockchairStats.data;
            if(s.mempool_transactions!=null)html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">멤풀 트랜잭션:</span> <span style="font-weight:700;">${fmt(s.mempool_transactions,0)}</span></div>`;
            if(s.average_transaction_fee_usd_24h!=null)html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">평균 수수료:</span> <span style="font-weight:700;">$${s.average_transaction_fee_usd_24h.toFixed(2)}</span></div>`;
            if(s.blocks_24h!=null)html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">24h 블록수:</span> <span style="font-weight:700;">${s.blocks_24h}</span></div>`;
        }
        txEl.innerHTML=html||'데이터 없음';
    }catch(e){txEl.innerHTML='<span style="color:var(--text-secondary)">거래 데이터 로딩 실패</span>';}

    // 3) 시장 구조 (CoinGecko + DeFiLlama)
    try{
        const [global,defi]=await Promise.all([
            fetch('https://api.coingecko.com/api/v3/global').then(r=>r.json()).catch(()=>null),
            fetch('https://api.llama.fi/v2/historicalChainTvl').then(r=>r.json()).catch(()=>null)
        ]);
        let html='';
        if(global?.data){
            const g=global.data;
            const mcap=g.total_market_cap?.usd||0;
            const btcDom=g.market_cap_percentage?.btc||0;
            const ethDom=g.market_cap_percentage?.eth||0;
            html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">총 마켓캡:</span> <span style="font-weight:700;color:${G}">$${fmt(mcap,0)}</span></div>`;
            html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">BTC 도미넌스:</span> <span style="font-weight:700;color:${YL}">${btcDom.toFixed(1)}%</span></div>`;
            html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">ETH 도미넌스:</span> <span style="font-weight:700;">${ethDom.toFixed(1)}%</span></div>`;
            if(g.total_volume?.usd)html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">24h 총 거래량:</span> <span style="font-weight:700;">$${fmt(g.total_volume.usd,0)}</span></div>`;
        }
        if(defi&&defi.length){
            const latest=defi[defi.length-1];
            html+=`<div style="margin:4px 0;"><span style="color:var(--text-secondary)">DeFi TVL:</span> <span style="font-weight:700;color:#a855f7">$${fmt(latest.tvl,0)}</span></div>`;
        }
        mktEl.innerHTML=html||'데이터 없음';
    }catch(e){mktEl.innerHTML='<span style="color:var(--text-secondary)">시장 데이터 로딩 실패</span>';}
}

/* ═══════════════════════════════════
   풀롱/풀숏 초정밀 시그널 (20개 조건 검증)
   미래 캔들 영역에 시그널 표시
   ═══════════════════════════════════ */
let lastFearGreedValue=50; // 공포탐욕지수 캐시
let lastLongShortRatio={buy:0.5,sell:0.5}; // 롱숏비율 캐시
let lastOIChange=0; // 미결제약정 변동률 캐시

function calcStochasticRSI(d,rsiPeriod=14,stochPeriod=14,kSmooth=3,dSmooth=3){
    const rsiData=calcRSI(d,rsiPeriod);
    if(rsiData.length<stochPeriod)return null;
    const rsiVals=rsiData.map(r=>r.value);
    const stochK=[];
    for(let i=stochPeriod-1;i<rsiVals.length;i++){
        const slice=rsiVals.slice(i-stochPeriod+1,i+1);
        const min=Math.min(...slice),max=Math.max(...slice);
        stochK.push(max===min?50:(rsiVals[i]-min)/(max-min)*100);
    }
    // Smooth K
    const smoothK=[];
    for(let i=kSmooth-1;i<stochK.length;i++){
        let s=0;for(let j=i-kSmooth+1;j<=i;j++)s+=stochK[j];
        smoothK.push(s/kSmooth);
    }
    // Smooth D
    const smoothD=[];
    for(let i=dSmooth-1;i<smoothK.length;i++){
        let s=0;for(let j=i-dSmooth+1;j<=i;j++)s+=smoothK[j];
        smoothD.push(s/dSmooth);
    }
    if(smoothK.length<2||smoothD.length<2)return null;
    return{k:smoothK[smoothK.length-1],kPrev:smoothK[smoothK.length-2],d:smoothD[smoothD.length-1],dPrev:smoothD[smoothD.length-2]};
}

function calcBollingerBands(d,period=20,stdMul=2){
    if(d.length<period)return null;
    const slice=d.slice(-period);
    const closes=slice.map(c=>c.close);
    const mean=closes.reduce((a,b)=>a+b,0)/period;
    const std=Math.sqrt(closes.reduce((a,b)=>a+(b-mean)**2,0)/period);
    return{upper:mean+std*stdMul,middle:mean,lower:mean-std*stdMul};
}

function calcOBVSeries(d){
    const obvs=[0];
    for(let i=1;i<d.length;i++){
        if(d[i].close>d[i-1].close)obvs.push(obvs[i-1]+d[i].volume);
        else if(d[i].close<d[i-1].close)obvs.push(obvs[i-1]-d[i].volume);
        else obvs.push(obvs[i-1]);
    }
    return obvs;
}

function generateFullSignal(d){
    if(d.length<110)return null; // 최소 데이터 필요
    const last=d[d.length-1],prev=d[d.length-2],prev2=d[d.length-3];
    const price=last.close;

    // 기존 지표 계산
    const rsiData=calcRSI(d,14);
    if(!rsiData.length)return null;
    const rsi=rsiData[rsiData.length-1].value;
    const rsiPrev=rsiData.length>=2?rsiData[rsiData.length-2].value:rsi;
    const macdD=calcMACD(d);
    const ma7=calcSMA(d,7),ma20=calcSMA(d,20),ma100=calcSMA(d,100);
    const m7=ma7.length?ma7[ma7.length-1].value:price;
    const m20=ma20.length?ma20[ma20.length-1].value:price;
    const m100=ma100.length?ma100[ma100.length-1].value:price;
    const macdHist=macdD.hist.length?macdD.hist[macdD.hist.length-1].value:0;
    const macdHistPrev=macdD.hist.length>=2?macdD.hist[macdD.hist.length-2].value:0;
    const body=Math.abs(last.close-last.open);
    const lowerWick=Math.min(last.open,last.close)-last.low;
    const upperWick=last.high-Math.max(last.open,last.close);

    let longConds=0,shortConds=0;
    const longReasons=[],shortReasons=[];

    // === 기존 8개 조건 ===
    // 1) RSI 과매도/과매수 반등
    if(rsi<40&&rsi>rsiPrev){longConds++;longReasons.push('RSI 반등');}
    if(rsi>60&&rsi<rsiPrev){shortConds++;shortReasons.push('RSI 하락');}
    // 2) 양봉/음봉
    if(last.close>last.open){longConds++;longReasons.push('양봉');}
    if(last.close<last.open){shortConds++;shortReasons.push('음봉');}
    // 3) 이전 봉 반전
    if(prev.close<prev.open&&last.close>last.open){longConds++;longReasons.push('반전 양봉');}
    if(prev.close>prev.open&&last.close<last.open){shortConds++;shortReasons.push('반전 음봉');}
    // 4) 거래량 증가
    if(last.volume>prev.volume*1.2){
        if(last.close>last.open){longConds++;longReasons.push('거래량↑양봉');}
        if(last.close<last.open){shortConds++;shortReasons.push('거래량↑음봉');}
    }
    // 5) MACD 히스토그램 방향
    if(macdHist>macdHistPrev){longConds++;longReasons.push('MACD↑');}
    if(macdHist<macdHistPrev){shortConds++;shortReasons.push('MACD↓');}
    // 6) MA7 위/아래
    if(price>m7){longConds++;longReasons.push('MA7↑');}
    if(price<m7){shortConds++;shortReasons.push('MA7↓');}
    // 7) 해머/슈팅스타
    if(lowerWick>body*1.5&&last.close>last.open){longConds++;longReasons.push('해머');}
    if(upperWick>body*1.5&&last.close<last.open){shortConds++;shortReasons.push('슈팅스타');}
    // 8) MA20 지지/저항
    if(last.low<m20&&last.close>m20){longConds++;longReasons.push('MA20 지지');}
    if(last.high>m20&&last.close<m20){shortConds++;shortReasons.push('MA20 저항');}

    // === 신규 12개 조건 ===
    // 9) Bollinger Band 터치 후 반등
    const bb=calcBollingerBands(d,20,2);
    if(bb){
        if(prev.low<=bb.lower&&last.close>bb.lower){longConds++;longReasons.push('BB하단 반등');}
        if(prev.high>=bb.upper&&last.close<bb.upper){shortConds++;shortReasons.push('BB상단 반락');}
    }
    // 10) MA20 > MA100 추세 정렬
    if(m20>m100){longConds++;longReasons.push('추세정렬↑');}
    if(m20<m100){shortConds++;shortReasons.push('추세정렬↓');}
    // 11) 이전 3봉 연속 같은 방향 후 반전
    if(d.length>=5){
        const c3=d[d.length-4],c2=d[d.length-3],c1=d[d.length-2];
        if(c3.close<c3.open&&c2.close<c2.open&&c1.close<c1.open&&last.close>last.open){longConds++;longReasons.push('3연음→양전환');}
        if(c3.close>c3.open&&c2.close>c2.open&&c1.close>c1.open&&last.close<last.open){shortConds++;shortReasons.push('3연양→음전환');}
    }
    // 12) ATR 대비 봉 크기 (변동성 돌파)
    const atr=calcATR(d,14);
    if(atr&&body>atr*1.2){
        if(last.close>last.open){longConds++;longReasons.push('ATR돌파↑');}
        if(last.close<last.open){shortConds++;shortReasons.push('ATR돌파↓');}
    }
    // 13) OBV 방향 일치
    const obvSeries=calcOBVSeries(d);
    if(obvSeries.length>=2){
        const obvNow=obvSeries[obvSeries.length-1],obvPrev=obvSeries[obvSeries.length-2];
        if(obvNow>obvPrev&&last.close>last.open){longConds++;longReasons.push('OBV↑');}
        if(obvNow<obvPrev&&last.close<last.open){shortConds++;shortReasons.push('OBV↓');}
    }
    // 14) 직전 5봉 최저가/최고가 돌파
    if(d.length>=6){
        const recent5=d.slice(-6,-1);
        const hi5=Math.max(...recent5.map(c=>c.high));
        const lo5=Math.min(...recent5.map(c=>c.low));
        if(last.close>hi5){longConds++;longReasons.push('5봉고점돌파');}
        if(last.close<lo5){shortConds++;shortReasons.push('5봉저점이탈');}
    }
    // 15) 공포탐욕지수 극단
    if(lastFearGreedValue<=20){longConds++;longReasons.push('극도공포');}
    if(lastFearGreedValue>=80){shortConds++;shortReasons.push('극도탐욕');}
    // 16) 롱숏비율 극단
    if(lastLongShortRatio.sell>=0.7){longConds++;longReasons.push('매도쏠림→롱');}
    if(lastLongShortRatio.buy>=0.7){shortConds++;shortReasons.push('매수쏠림→숏');}
    // 17) 미결제약정 급증
    if(lastOIChange>=5){
        if(last.close>last.open){longConds++;longReasons.push('OI급증+롱');}
        if(last.close<last.open){shortConds++;shortReasons.push('OI급증+숏');}
    }
    // 18) Stochastic RSI 크로스
    const stochRsi=calcStochasticRSI(d);
    if(stochRsi){
        if(stochRsi.kPrev<stochRsi.dPrev&&stochRsi.k>stochRsi.d){longConds++;longReasons.push('StochRSI↑');}
        if(stochRsi.kPrev>stochRsi.dPrev&&stochRsi.k<stochRsi.d){shortConds++;shortReasons.push('StochRSI↓');}
    }
    // 19) VWAP 위/아래
    const vwap=calcVWAP(d.slice(-50));
    if(price>vwap*1.002){longConds++;longReasons.push('VWAP↑');}
    if(price<vwap*0.998){shortConds++;shortReasons.push('VWAP↓');}
    // 20) 이전 2봉 거래량 평균 대비 2배+ 폭발
    if(d.length>=3){
        const avgVol2=(d[d.length-2].volume+d[d.length-3].volume)/2;
        if(avgVol2>0&&last.volume>avgVol2*2){
            if(last.close>last.open){longConds++;longReasons.push('거래량폭발↑');}
            if(last.close<last.open){shortConds++;shortReasons.push('거래량폭발↓');}
        }
    }

    // 풀롱: 10개+ 롱 && 숏 3개 미만
    // 풀숏: 10개+ 숏 && 롱 3개 미만
    let signal=null;
    if(longConds>=10&&shortConds<3){
        signal={type:'풀롱',color:'#FFD700',longConds,shortConds,reasons:longReasons};
    }else if(shortConds>=10&&longConds<3){
        signal={type:'풀숏',color:'#9400D3',shortConds,longConds,reasons:shortReasons};
    }

    return{longConds,shortConds,signal,longReasons,shortReasons};
}

// 개별 캔들에 대한 풀롱/풀숏 기술적 조건 검사 (과거 캔들용, 15개 기술적 조건만)
function checkFullSignalAtCandle(d,idx){
    if(idx<5||idx>=d.length)return null;
    const c=d[idx],prev=d[idx-1],prev2=d[idx-2];
    const price=c.close;
    // RSI
    const rsiData=calcRSI(d.slice(0,idx+1),14);
    if(rsiData.length<2)return null;
    const rsi=rsiData[rsiData.length-1].value;
    const rsiPrev=rsiData[rsiData.length-2].value;
    // MACD
    const macdD=calcMACD(d.slice(0,idx+1));
    const macdH=macdD.hist.length?macdD.hist[macdD.hist.length-1].value:0;
    const macdHP=macdD.hist.length>=2?macdD.hist[macdD.hist.length-2].value:0;
    // MA
    const sliceForMA=d.slice(0,idx+1);
    const ma7=calcSMA(sliceForMA,7),ma20=calcSMA(sliceForMA,20),ma100=calcSMA(sliceForMA,100);
    const m7=ma7.length?ma7[ma7.length-1].value:price;
    const m20=ma20.length?ma20[ma20.length-1].value:price;
    const m100=ma100.length?ma100[ma100.length-1].value:price;
    const body=Math.abs(c.close-c.open);
    const lWick=Math.min(c.open,c.close)-c.low;
    const uWick=c.high-Math.max(c.open,c.close);

    let lc=0,sc=0;
    // 1) RSI
    if(rsi<40&&rsi>rsiPrev)lc++;
    if(rsi>60&&rsi<rsiPrev)sc++;
    // 2) 양봉/음봉
    if(c.close>c.open)lc++;
    if(c.close<c.open)sc++;
    // 3) 반전
    if(prev.close<prev.open&&c.close>c.open)lc++;
    if(prev.close>prev.open&&c.close<c.open)sc++;
    // 4) 거래량
    if(c.volume>prev.volume*1.2){
        if(c.close>c.open)lc++;
        if(c.close<c.open)sc++;
    }
    // 5) MACD
    if(macdH>macdHP)lc++;
    if(macdH<macdHP)sc++;
    // 6) MA7
    if(price>m7)lc++;
    if(price<m7)sc++;
    // 7) 해머/슈팅스타
    if(lWick>body*1.5&&c.close>c.open)lc++;
    if(uWick>body*1.5&&c.close<c.open)sc++;
    // 8) MA20 지지/저항
    if(c.low<m20&&c.close>m20)lc++;
    if(c.high>m20&&c.close<m20)sc++;
    // 9) BB
    const bb=calcBollingerBands(d.slice(0,idx+1),20,2);
    if(bb){
        if(prev.low<=bb.lower&&c.close>bb.lower)lc++;
        if(prev.high>=bb.upper&&c.close<bb.upper)sc++;
    }
    // 10) 추세정렬
    if(m20>m100)lc++;
    if(m20<m100)sc++;
    // 11) 3연봉 반전
    if(idx>=4){
        const c3=d[idx-3],c2=d[idx-2],c1=d[idx-1];
        if(c3.close<c3.open&&c2.close<c2.open&&c1.close<c1.open&&c.close>c.open)lc++;
        if(c3.close>c3.open&&c2.close>c2.open&&c1.close>c1.open&&c.close<c.open)sc++;
    }
    // 12) ATR 돌파
    const atr=calcATR(d.slice(0,idx+1),14);
    if(atr&&body>atr*1.2){
        if(c.close>c.open)lc++;
        if(c.close<c.open)sc++;
    }
    // 13) VWAP
    const vwap=calcVWAP(d.slice(Math.max(0,idx-49),idx+1));
    if(price>vwap*1.002)lc++;
    if(price<vwap*0.998)sc++;
    // 14) 5봉 돌파
    if(idx>=6){
        const r5=d.slice(idx-5,idx);
        const hi5=Math.max(...r5.map(x=>x.high));
        const lo5=Math.min(...r5.map(x=>x.low));
        if(c.close>hi5)lc++;
        if(c.close<lo5)sc++;
    }
    // 15) 거래량 폭발
    if(idx>=3){
        const av2=(d[idx-1].volume+d[idx-2].volume)/2;
        if(av2>0&&c.volume>av2*2){
            if(c.close>c.open)lc++;
            if(c.close<c.open)sc++;
        }
    }
    // 기술적 조건만 15개: 롱 8개+, 숏 2개 미만 = 풀롱
    if(lc>=8&&sc<2)return{type:'풀롱',lc,sc};
    if(sc>=8&&lc<2)return{type:'풀숏',lc,sc};
    return null;
}

// 풀롱/풀숏 마커를 캔들차트에 추가 (과거 + 미래)
function addFullSignalMarkers(d,existingMarkers){
    const markers=[...existingMarkers];

    // 1) 과거 캔들 스캔 (최근 200봉, 매 5봉마다 검사 — 성능 최적화)
    const startIdx=Math.max(30,d.length-200);
    for(let i=startIdx;i<d.length;i+=3){
        const sig=checkFullSignalAtCandle(d,i);
        if(sig){
            if(sig.type==='풀롱'){
                markers.push({time:d[i].time,position:'belowBar',color:'#FFD700',shape:'arrowUp',text:`풀롱(${sig.lc})`});
            }else{
                markers.push({time:d[i].time,position:'aboveBar',color:'#9400D3',shape:'arrowDown',text:`풀숏(${sig.sc})`});
            }
        }
    }

    // 2) 현재 시점: 20개 전체 조건 (외부 데이터 포함)
    const result=generateFullSignal(d);
    if(!result)return markers;

    // 시그널 패널 업데이트
    const sigEl=document.getElementById('signalContent');
    if(sigEl){
        // 기존 풀롱/풀숏 태그 제거
        const spans=sigEl.querySelectorAll('span');
        spans.forEach(s=>{if(s.textContent.includes('풀롱')||s.textContent.includes('풀숏'))s.remove();});
        // 현재 상태 표시
        const tag=result.signal
            ?(result.signal.type==='풀롱'
                ?`<span style="background:#FFD700;color:#000;padding:3px 10px;border-radius:4px;font-weight:900;font-size:16px;margin-left:8px;animation:pulse 1s infinite;">⚡ 풀롱 (${result.longConds}/20)</span>`
                :`<span style="background:#9400D3;color:#fff;padding:3px 10px;border-radius:4px;font-weight:900;font-size:16px;margin-left:8px;animation:pulse 1s infinite;">⚡ 풀숏 (${result.shortConds}/20)</span>`)
            :`<span style="color:var(--text-secondary);font-size:11px;margin-left:8px;">풀롱/풀숏: 롱${result.longConds} 숏${result.shortConds}/20</span>`;
        sigEl.innerHTML+=tag;
    }

    // 미래 캔들 영역에 항상 풀롱/풀숏 예측 표시
    const intervalSec={'1':60,'5':300,'15':900,'30':1800,'60':3600,'240':14400,'D':86400,'W':604800};
    const intSec=intervalSec[currentInterval]||3600;
    const futureTime=d[d.length-1].time+intSec;
    const futureTime2=d[d.length-1].time+intSec*2;

    if(result.signal){
        // 강한 시그널 (10/20+): 큰 금색/보라색 화살표
        if(result.signal.type==='풀롱'){
            markers.push({time:futureTime,position:'belowBar',color:'#FFD700',shape:'arrowUp',text:`⚡풀롱(${result.longConds}/20)`});
            markers.push({time:futureTime2,position:'belowBar',color:'#FFD700',shape:'arrowUp',text:`풀롱 진입▲`});
        }else{
            markers.push({time:futureTime,position:'aboveBar',color:'#9400D3',shape:'arrowDown',text:`⚡풀숏(${result.shortConds}/20)`});
            markers.push({time:futureTime2,position:'aboveBar',color:'#9400D3',shape:'arrowDown',text:`풀숏 진입▼`});
        }
    }else{
        // 미달이어도 방향 예측 항상 표시
        const isLongBias=result.longConds>result.shortConds;
        const dominant=isLongBias?result.longConds:result.shortConds;
        const label=isLongBias?`롱 대기(${result.longConds}/20)`:`숏 대기(${result.shortConds}/20)`;
        const color=isLongBias?'rgba(255,215,0,0.6)':'rgba(148,0,211,0.6)';
        const pos=isLongBias?'belowBar':'aboveBar';
        const shape=isLongBias?'arrowUp':'arrowDown';
        markers.push({time:futureTime,position:pos,color:color,shape:shape,text:label});
    }

    return markers;
}

/* ═══════════════════════════════════
   갱신 + 이벤트
   ═══════════════════════════════════ */
let refreshCount=0;
async function refreshAll(){
    refreshCount++;
    // 매 1초: 시세+호가창+차트+지표 (풀롱/풀숏 포함)
    const tasks=[updateTicker(),updateOrderbook(),updateTVChart()];
    // 매 3초: 청산+시장지표
    if(refreshCount%3===0){
        tasks.push(updateLiquidation(),updateMarketIndicators());
    }
    // 매 10초: 거래량알람 (무거운 API - 50개 코인 조회)
    if(refreshCount%10===0){
        tasks.push(checkAlerts());
    }
    // 매 30초: 전문가 컨센서스 (CoinGecko 호출 제한 고려)
    if(refreshCount%30===0){
        tasks.push(updateExpertConsensus());
    }
    // 매 60초: 매크로 + 온체인 데이터
    if(refreshCount%60===0){
        tasks.push(updateMacroData(),updateOnchainData());
    }
    await Promise.all(tasks);
}

function destroyCharts(){[orderbookChart,liqChart].forEach(c=>{if(c)c.destroy();});orderbookChart=liqChart=null;}

document.getElementById('symbolSelect').addEventListener('change',e=>{
    currentSymbol=e.target.value;destroyCharts();
    document.getElementById('orderbookTable').innerHTML='';
    // 청산 히트맵 오버레이 즉시 클리어
    const liqCv=document.getElementById('liqHeatmapOverlay');
    if(liqCv){const lctx=liqCv.getContext('2d');lctx.clearRect(0,0,liqCv.width,liqCv.height);}
    lastKlineData=[];liqFeedItems=[];whaleFeedItems=[];
    // 차트 완전 재생성 (가격 범례 리셋)
    srLines=[];cmeGapLines=[];fibLines=[];
    initTVChart().then(()=>{updateTVChart();});
    initRSIChart();initMACDChart();
    refreshAll();connectWS();
});
document.getElementById('intervalSelect').addEventListener('change',e=>{currentInterval=e.target.value;updateTVChart();});

/* ═══════════════════════════════════
   자동매매 제어
   ═══════════════════════════════════ */
let traderConnected=false,autoTradeOn=false,lastAutoTradeTime=0;

async function connectTrader(){
    const key=document.getElementById('apiKey').value;
    const secret=document.getElementById('apiSecret').value;
    const testnet=document.getElementById('tradeMode').value==='testnet';
    if(!key||!secret){alert('API Key와 Secret을 입력하세요');return;}
    const st=document.getElementById('traderStatus');
    st.textContent='연결 중...';
    try{
        const r=await fetch('/api/trader/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({api_key:key,api_secret:secret,testnet})});
        const d=await r.json();
        if(d.status==='connected'){
            traderConnected=true;
            let bal='';try{const coins=d.balance?.result?.list?.[0]?.coin||[];const u=coins.find(c=>c.coin==='USDT');bal=u?` | 잔고: ${parseFloat(u.walletBalance).toFixed(2)} USDT`:'';}catch(e){}
            st.innerHTML=`<span style="color:${G}">연결됨 (${testnet?'테스트넷':'실거래'})${bal}</span>`;
        }else st.innerHTML=`<span style="color:${R}">실패: ${d.message}</span>`;
    }catch(e){st.innerHTML=`<span style="color:${R}">${e.message}</span>`;}
}

async function toggleAutoTrade(){
    if(!traderConnected){alert('먼저 API 키로 연결하세요');return;}
    autoTradeOn=!autoTradeOn;
    const b=document.getElementById('btnAutoTrade');
    b.textContent=autoTradeOn?'자동매매 ON':'자동매매 OFF';b.style.background=autoTradeOn?G:R;
    // 설정 저장
    const cfg={symbol:currentSymbol,leverage:document.getElementById('cfgLeverage').value,qty_usdt:document.getElementById('cfgQty').value,
        tp_pct:parseFloat(document.getElementById('cfgTP').value),sl_pct:parseFloat(document.getElementById('cfgSL').value),min_score:parseInt(document.getElementById('cfgMinScore').value)};
    await fetch('/api/trader/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(cfg)});
    await fetch('/api/trader/toggle',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:autoTradeOn})});
}

async function checkAutoTrade(){
    if(!autoTradeOn||!traderConnected)return;
    const now=Date.now();
    if(now-lastAutoTradeTime<30000)return; // 30초 쿨다운
    const dir=document.getElementById('signalDirection')?.textContent||'';
    const sm=document.getElementById('signalScore')?.textContent?.match(/순: ([+-]?\d+)/);
    const score=sm?parseInt(sm[1]):0;
    const price=parseFloat(document.getElementById('tickPrice')?.textContent?.replace(/,/g,'')||0);
    if(!price)return;
    let direction='';
    if(dir.includes('LONG')&&score>0)direction='LONG';
    if(dir.includes('SHORT')&&score<0)direction='SHORT';
    if(!direction)return;
    lastAutoTradeTime=now;
    try{
        const r=await fetch('/api/trader/signal-trade',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({direction,score:Math.abs(score),price})});
        const d=await r.json();
        if(d.status==='executed')updateTradeLog();
    }catch(e){}
}

async function updateTradeLog(){
    try{
        const r=await fetchJSON('/api/trader/log');
        const el=document.getElementById('tradeLog');
        if(!r.log?.length){el.innerHTML='<div style="color:#8b949e;font-size:11px;">매매 기록 없음</div>';return;}
        el.innerHTML=r.log.slice(-10).reverse().map(l=>`<div class="alert-item"><span style="color:${TX};font-size:9px;">${l.testnet?'[테스트]':'[실거래]'}</span><span style="color:${l.side==='Buy'?G:R};font-weight:700;">${l.side==='Buy'?'롱':'숏'}</span><span>${fp(l.price)}</span><span style="color:${G}">TP:${l.tp}</span><span style="color:${R}">SL:${l.sl}</span><span style="font-size:9px;">${l.result}</span></div>`).join('');
    }catch(e){}
}

/* ───── 초기화 ───── */
(async function(){
    await initTVChart();initRSIChart();initMACDChart();
    await updateTVChart();refreshAll();connectWS();
    // 초기 로드: 컨센서스, 매크로, 온체인
    updateExpertConsensus();updateMacroData();updateOnchainData();
    refreshInterval=setInterval(()=>{refreshAll();checkAutoTrade();},1000);
})();
