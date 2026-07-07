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

/* ───── 주식 모드 (Yahoo Finance 기반) ───── */
function isStock(sym){return sym&&sym.startsWith('STK:');}
function getYahooSym(sym){return sym.replace('STK:','');}
let stockCurrency='';

async function yahooKline(yahooSym,interval='60',limit=500){
    const intMap={'1':'1m','5':'5m','15':'15m','30':'30m','60':'1h','240':'4h','D':'1d','W':'1wk'};
    const rangeMap={'1':'7d','5':'60d','15':'60d','30':'60d','60':'2y','240':'2y','D':'10y','W':'10y'};
    const yi=intMap[interval]||'1h';
    const yr=rangeMap[interval]||'1mo';
    const data=await fetchJSON(`/api/stock/chart/${encodeURIComponent(yahooSym)}?range=${yr}&interval=${yi}`);
    const r=data.chart?.result?.[0];
    if(!r||!r.timestamp)throw new Error('Yahoo no data');
    const ts=r.timestamp,q=r.indicators.quote[0];
    stockCurrency=r.meta?.currency||'';
    const out=[];
    for(let i=0;i<ts.length;i++){
        if(q.open[i]!=null&&q.close[i]!=null&&q.high[i]!=null&&q.low[i]!=null)
            out.push({time:ts[i],open:q.open[i],high:q.high[i],low:q.low[i],close:q.close[i],volume:q.volume[i]||0});
    }
    return out;
}

async function updateStockTicker(yahooSym){
    try{
        const data=await fetchJSON(`/api/stock/chart/${encodeURIComponent(yahooSym)}?range=2d&interval=1d`);
        const r=data.chart?.result?.[0];
        if(!r)return;
        const m=r.meta;
        const price=m.regularMarketPrice||0;
        const prev=m.chartPreviousClose||m.previousClose||price;
        const ch=prev>0?((price-prev)/prev*100):0;
        const cur=m.currency||'';
        const prefix=cur==='KRW'?'₩':'$';
        document.getElementById('tickPrice').textContent=price>=1000?prefix+price.toLocaleString('en-US',{maximumFractionDigits:cur==='KRW'?0:2}):prefix+price.toFixed(2);
        const ce=document.getElementById('tickChange');
        ce.textContent=(ch>=0?'+':'')+ch.toFixed(2)+'%';
        ce.className='ticker-value '+(ch>=0?'positive':'negative');
        document.getElementById('tickVolume').textContent=fmt(m.regularMarketVolume||0,0);
        document.getElementById('tickOI').textContent=m.exchangeName||'-';
        const fe=document.getElementById('tickFunding');
        fe.textContent=cur;fe.className='ticker-value';
    }catch(e){}
}

/* ───── 청산 히트맵 추정 v4: 거래량 프로파일 기반 ─────
   ⚠️ 실제 집계 청산 데이터가 아님 (무료 공개 API로는 못 받음 — Coinglass/Hyblock은 유료).
   그러나 기존 v3의 '모든 포지션이 현재가에 진입했다'는 비현실적 가정을 버리고,
   실제 거래된 캔들의 가격×거래량(=포지션이 실제로 열렸을 법한 곳)에 레버리지 밴드를
   적용해 청산 군집을 추정한다. 진입 이후 가격이 이미 쓸고 지나간 군집은 제거(스윕 반영).
   이는 Coinglass/Hyblock의 leverage-band 방법론과 동일한 접근으로, 추정이지만 v3보다
   훨씬 시장 현실에 근접한다. (확정 청산값이 아니라 '청산이 몰려 있을 확률' 추정임) */
const LEV_WEIGHTS={3:0.15,5:0.25,10:0.25,25:0.20,50:0.10,100:0.05};
const LEV_LEVELS=[3,5,10,25,50,100];

function estimateLiquidationLevels(currentPrice,oiValue,bids,asks,klines,rangeP=0.15,bins=100){
    if(currentPrice<=0)return{price_levels:[],long_liquidations:[],short_liquidations:[],leverage_markers:[],current_price:0,real_data:false};
    const low=currentPrice*(1-rangeP),high=currentPrice*(1+rangeP);
    const priceLevels=[];
    for(let i=0;i<bins;i++)priceLevels.push(low+(high-low)*i/(bins-1));
    const binW=(high-low)/(bins-1);
    const longClusters=new Float64Array(bins),shortClusters=new Float64Array(bins);
    const obLong=new Float64Array(bins),obShort=new Float64Array(bins);
    const leverageMarkers=[];
    const mm=0.005;

    // 현재가 기준 레버리지별 청산 참고선 (지금 진입 시 청산가 — 단순 참고용)
    for(const lev of LEV_LEVELS){
        leverageMarkers.push({leverage:`${lev}x`,
            long_liq_price:+(currentPrice*(1-(1/lev)+mm)).toFixed(6),
            short_liq_price:+(currentPrice*(1+(1/lev)-mm)).toFixed(6)});
    }

    // 가격 p 주변 bin들에 가우시안 가중치로 분산 가산
    const addCluster=(arr,p,wgt)=>{
        if(p<low||p>high||wgt<=0)return;
        const sigma=binW*1.5;
        for(let i=0;i<bins;i++){
            const dd=(priceLevels[i]-p)/sigma;
            if(dd>-4&&dd<4)arr[i]+=wgt*Math.exp(-0.5*dd*dd);
        }
    };

    // ── 1) 거래량 프로파일 기반 청산 군집 (실거래 앵커) ──
    let haveVP=false;
    if(klines&&klines.length>=20){
        haveVP=true;
        const n=klines.length;
        const nowT=klines[n-1].time;
        const spanT=(nowT-klines[0].time)||1;
        // 진입 이후 가격이 청산가를 건드렸는지 판정용 suffix min(low)/max(high)
        const sufMin=new Float64Array(n),sufMax=new Float64Array(n);
        sufMin[n-1]=klines[n-1].low;sufMax[n-1]=klines[n-1].high;
        for(let i=n-2;i>=0;i--){
            sufMin[i]=Math.min(klines[i+1].low,sufMin[i+1]);
            sufMax[i]=Math.max(klines[i+1].high,sufMax[i+1]);
        }
        for(let i=0;i<n;i++){
            const c=klines[i];
            const vol=c.volume;if(!(vol>0))continue;
            const entry=(c.high+c.low+c.close)/3;
            const age=(nowT-c.time)/spanT;        // 0=최신 .. 1=가장 오래됨
            const recency=Math.exp(-1.5*age);      // 오래된 포지션은 정리/롤오버됐을 확률↑ → 가중↓
            const minLowAfter=sufMin[i],maxHighAfter=sufMax[i];
            for(const lev of LEV_LEVELS){
                const w=LEV_WEIGHTS[lev]*recency*vol;
                const longLiq=entry*(1-(1/lev)+mm);
                const shortLiq=entry*(1+(1/lev)-mm);
                // 진입 후 가격이 청산가에 닿지 않은(=아직 살아있는) 포지션만 카운트 (스윕된 군집 제거)
                if(minLowAfter>longLiq)addCluster(longClusters,longLiq,w);
                if(maxHighAfter<shortLiq)addCluster(shortClusters,shortLiq,w);
            }
        }
    }

    // ── 2) 호가창 매물벽 (실시간 실데이터) ──
    let haveOB=false;
    if(bids&&asks&&bids.length&&asks.length){
        haveOB=true;
        const allQ=[...bids.map(b=>parseFloat(b[1])),...asks.map(a=>parseFloat(a[1]))];
        const avgQ=allQ.reduce((a,b)=>a+b,0)/allQ.length||1;
        for(const bid of bids.slice(0,200)){
            const bp=parseFloat(bid[0]),bq=parseFloat(bid[1]);
            if(bq>avgQ*1.5)addCluster(obLong,bp,bq/avgQ);
        }
        for(const ask of asks.slice(0,200)){
            const ap=parseFloat(ask[0]),aq=parseFloat(ask[1]);
            if(aq>avgQ*1.5)addCluster(obShort,ap,aq/avgQ);
        }
    }

    // ── 3) 각각 정규화 후 결합 (거래량프로파일 0.6 + 호가벽 0.4) ──
    const norm=(arr)=>{let m=0;for(const v of arr)if(v>m)m=v;return m>0?Array.from(arr,v=>v/m):Array.from(arr);};
    const vL=norm(longClusters),vS=norm(shortClusters),oL=norm(obLong),oS=norm(obShort);
    let VP_W=0,OB_W=0;
    if(haveVP&&haveOB){VP_W=0.6;OB_W=0.4;}
    else if(haveVP){VP_W=1;}
    else if(haveOB){OB_W=1;}
    const longLiqs=new Float64Array(bins),shortLiqs=new Float64Array(bins);
    for(let i=0;i<bins;i++){
        longLiqs[i]=vL[i]*VP_W+oL[i]*OB_W;
        shortLiqs[i]=vS[i]*VP_W+oS[i]*OB_W;
    }
    // 최종 정규화 (최대=100)
    let maxV=1;
    for(let i=0;i<bins;i++){if(longLiqs[i]>maxV)maxV=longLiqs[i];if(shortLiqs[i]>maxV)maxV=shortLiqs[i];}
    const longArr=[],shortArr=[],plArr=[];
    for(let i=0;i<bins;i++){
        longArr.push(+(longLiqs[i]/maxV*100).toFixed(2));
        shortArr.push(+(shortLiqs[i]/maxV*100).toFixed(2));
        plArr.push(+priceLevels[i].toFixed(6));
    }
    return{price_levels:plArr,long_liquidations:longArr,short_liquidations:shortArr,
        leverage_markers:leverageMarkers,current_price:currentPrice,
        // 신호용 real_data는 '실시간 호가창 매물벽'이 있을 때만 true (보수적 — 추정 군집으로는 매매신호 안 냄)
        real_data:haveOB,vp_data:haveVP,method:'volume_profile'};
}

/* ───── 브라우저에서 청산 데이터 계산 ───── */
async function fetchLiquidationData(sym){
    const [ticker,oiList,ob,kl]=await Promise.all([
        bybitTickers(sym),
        bybitOI(sym,'1h',1),
        bybitOrderbook(sym,200),
        bybitKline(sym,'60',500).catch(()=>[]),  // ~20일 시간봉 = 포지션 진입 분포 추정용
    ]);
    const curPrice=parseFloat(ticker.lastPrice||0);
    const oiVal=oiList.length?parseFloat(oiList[0].openInterest)*curPrice:0;
    return estimateLiquidationLevels(curPrice,oiVal,ob.b||[],ob.a||[],kl||[]);
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

function calcADX(d,p=14){
    if(d.length<p*2+1)return null;
    const plusDM=[],minusDM=[],trs=[];
    for(let i=1;i<d.length;i++){
        const upMove=d[i].high-d[i-1].high;
        const downMove=d[i-1].low-d[i].low;
        plusDM.push(upMove>downMove&&upMove>0?upMove:0);
        minusDM.push(downMove>upMove&&downMove>0?downMove:0);
        trs.push(Math.max(d[i].high-d[i].low,Math.abs(d[i].high-d[i-1].close),Math.abs(d[i].low-d[i-1].close)));
    }
    // Wilder smoothing
    let sPDM=plusDM.slice(0,p).reduce((a,b)=>a+b,0);
    let sMDM=minusDM.slice(0,p).reduce((a,b)=>a+b,0);
    let sTR=trs.slice(0,p).reduce((a,b)=>a+b,0);
    const dxArr=[];
    for(let i=p;i<trs.length;i++){
        sPDM=sPDM-sPDM/p+plusDM[i];
        sMDM=sMDM-sMDM/p+minusDM[i];
        sTR=sTR-sTR/p+trs[i];
        const pDI=sTR>0?(sPDM/sTR)*100:0;
        const mDI=sTR>0?(sMDM/sTR)*100:0;
        const sum=pDI+mDI;
        dxArr.push({dx:sum>0?Math.abs(pDI-mDI)/sum*100:0,pDI,mDI});
    }
    if(dxArr.length<p)return null;
    let adx=dxArr.slice(0,p).reduce((a,b)=>a+b.dx,0)/p;
    for(let i=p;i<dxArr.length;i++)adx=(adx*(p-1)+dxArr[i].dx)/p;
    const last=dxArr[dxArr.length-1];
    return{adx:adx,plusDI:last.pDI,minusDI:last.mDI};
}

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
        const d=isStock(currentSymbol)
            ?await yahooKline(getYahooSym(currentSymbol),currentInterval,500)
            :await bybitKline(currentSymbol,currentInterval,500);
        if(!d.length)return;
        lastKlineData=d;
        candleSeries.setData(d);
        // 거래량: turnover(USDT 거래대금) 우선, 없으면 volume*close 추정 (Bybit 공식 차트와 일치)
        volumeSeries.setData(d.map(x=>({time:x.time,value:(x.turnover||x.volume*x.close||x.volume),color:x.close>=x.open?'rgba(0,210,106,0.25)':'rgba(255,71,87,0.25)'})));

        // MA (현재 시간프레임 기준 N봉 단순평균)
        const leg=[];
        for(const p of MA_P){const ma=calcSMA(d,p);maSeries[p].setData(ma);if(ma.length)leg.push(`<span style="color:${MA_C[p]}">MA${p}:${fp(ma[ma.length-1].value)}</span>`);}
        document.getElementById('maLegend').innerHTML=leg.join(' | ')+'<span style="color:var(--text-secondary);margin-left:8px;font-size:9px;">(N=현재 시간프레임 봉 수)</span>';

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
        // 청산물량 히트맵 + 풀롱/풀숏 가격대 (더블 버퍼링, 깜빡임 방지)
        renderChartOverlay();
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
function findSRLevels(d){
    if(d.length<30)return[];
    const pvts=findPivots(d,5,5);
    const price=d[d.length-1].close;
    const tol=price*0.003;
    const all=[];
    pvts.highs.forEach(h=>all.push(h.price));
    pvts.lows.forEach(l=>all.push(l.price));
    all.sort((a,b)=>a-b);
    const clusters=[];
    for(const lv of all){
        let found=false;
        for(const c of clusters){if(Math.abs(c.p-lv)<tol){c.n++;c.p=(c.p*(c.n-1)+lv)/c.n;found=true;break;}}
        if(!found)clusters.push({p:lv,n:1});
    }
    return clusters.filter(c=>c.n>=2).map(c=>c.p);
}

/* ═══════════════════════════════════
   추세 맥락 / 고급 패턴 감지
   ═══════════════════════════════════ */

// 상위추세 판별 (MA200 기반)
// bull = 상승추세, bear = 하락추세, neutral = 횡보
function detectHigherTFTrend(d){
    if(d.length<200)return'neutral';
    const ma200=calcSMA(d,200);
    if(!ma200.length)return'neutral';
    const last=d[d.length-1].close;
    const ma=ma200[ma200.length-1];
    // 10봉 전 MA와 비교해서 기울기도 확인
    const ma10ago=ma200.length>=10?ma200[ma200.length-10]:ma;
    const slope=ma-ma10ago;
    const dist=(last-ma)/ma;
    if(dist>0.02&&slope>=0)return'bull';
    if(dist<-0.02&&slope<=0)return'bear';
    return'neutral';
}

// Wyckoff Spring: 지지 가짜이탈 후 V자 회복 (매집/매수 우위)
// Upthrust: 저항 가짜돌파 후 급락 (분배/매도 우위)
function detectWyckoffSpring(d,lookback=20){
    if(d.length<lookback+3)return null;
    const prev=d.slice(-lookback-3,-3);
    const last3=d.slice(-3);
    const support=Math.min(...prev.map(c=>c.low));
    const resistance=Math.max(...prev.map(c=>c.high));
    const lastC=last3[last3.length-1];

    // Bullish Spring: 최근 3봉 중 하나라도 지지 이탈, 마지막 봉이 지지 위 회복 + 양봉
    const dippedBelow=last3.some(c=>c.low<support);
    const closedAbove=lastC.close>support;
    const bullish=lastC.close>lastC.open;
    if(dippedBelow&&closedAbove&&bullish){
        // 강도 계산: 이탈 폭 대비 회복력
        const maxDip=Math.min(...last3.map(c=>c.low));
        const recovery=(lastC.close-maxDip)/lastC.close;
        if(recovery>0.005)return{type:'bullish_spring',strength:3};
    }

    // Bearish Upthrust: 저항 가짜돌파 + 마지막 봉 하락 마감
    const pokedAbove=last3.some(c=>c.high>resistance);
    const closedBelow=lastC.close<resistance;
    const bearish=lastC.close<lastC.open;
    if(pokedAbove&&closedBelow&&bearish){
        const maxPoke=Math.max(...last3.map(c=>c.high));
        const decline=(maxPoke-lastC.close)/lastC.close;
        if(decline>0.005)return{type:'bearish_upthrust',strength:3};
    }
    return null;
}

// Bull/Bear Flag: 강한 추세(깃대) + 역방향 완만한 조정(깃발) + 볼륨 감소
function detectFlag(d){
    if(d.length<15)return null;
    const pole=d.slice(-15,-6); // 깃대 9봉
    const flag=d.slice(-6);      // 깃발 6봉
    if(pole.length<6)return null;

    const poleRange=pole[pole.length-1].close-pole[0].close;
    const polePct=Math.abs(poleRange)/pole[0].close;
    if(polePct<0.02)return null; // 깃대 2% 미만은 약함

    const flagRange=flag[flag.length-1].close-flag[0].close;
    const flagPct=Math.abs(flagRange)/flag[0].close;

    const poleVol=pole.reduce((s,c)=>s+(c.volume||0),0)/pole.length;
    const flagVol=flag.reduce((s,c)=>s+(c.volume||0),0)/flag.length;
    const volDecline=flagVol<poleVol*0.8;

    // Bull Flag: 상승 깃대 + 약한 하락/횡보 깃발 + 볼륨 감소
    if(poleRange>0&&flagRange<=0&&flagPct<polePct*0.5&&volDecline){
        return{type:'bull_flag',strength:2};
    }
    // Bear Flag: 하락 깃대 + 약한 상승/횡보 깃발 + 볼륨 감소
    if(poleRange<0&&flagRange>=0&&flagPct<polePct*0.5&&volDecline){
        return{type:'bear_flag',strength:2};
    }
    return null;
}

// 저항 반복 터치 + 볼륨 감소 → 추세 맥락별 해석
// 상승추세: 돌파 임박 (롱 우위)
// 하락추세: 돌파 실패 후 매물대 쌓임 (숏 우위)
function detectResistanceGrind(d,htTrend){
    if(d.length<30)return null;
    const recent=d.slice(-25);
    const price=recent[recent.length-1].close;

    // 최근 고점 영역 찾기 (상위 10%)
    const highs=recent.map(c=>c.high).sort((a,b)=>b-a);
    const resistZone=highs[Math.floor(highs.length*0.1)];
    const tol=price*0.005;
    // 저항 근처 터치 횟수 (wick이 저항 근처 닿음)
    const touches=recent.filter(c=>c.high>=resistZone-tol&&c.close<resistZone).length;

    // 볼륨 추세 (최근 10봉 vs 이전 10봉)
    const volLate=recent.slice(-10).reduce((s,c)=>s+(c.volume||0),0)/10;
    const volEarly=recent.slice(0,10).reduce((s,c)=>s+(c.volume||0),0)/10;
    const volFalling=volLate<volEarly*0.85;

    if(touches>=3&&volFalling){
        if(htTrend==='bull')return{type:'bull_coil',strength:2}; // 돌파 임박
        if(htTrend==='bear')return{type:'bear_distribution',strength:2}; // 매물 분배
    }
    return null;
}

/* ═══════════════════════════════════
   가격/시점 예측 모듈 (확률 기반)
   ═══════════════════════════════════ */

// 1) 시간대별/요일별 통계 패턴 (UTC+9 한국시간 기준)
//    return: {hours: [{hour, avgChange, upRate}], days: [{day, avgChange, upRate}]}
function analyzeTimePatterns(d){
    if(d.length<50)return null;
    const hourMap={},dayMap={};
    for(let i=1;i<d.length;i++){
        const c=d[i],p=d[i-1];
        if(!(p.close>0))continue; // 분모 0 가드 → NaN 방지
        const date=new Date(c.time*1000);
        const hr=date.getHours(); // 로컬 시간 (브라우저 KST 가정)
        const dw=date.getDay();
        const ch=(c.close-p.close)/p.close*100;
        if(!hourMap[hr])hourMap[hr]={sum:0,n:0,up:0};
        hourMap[hr].sum+=ch;hourMap[hr].n++;if(ch>0)hourMap[hr].up++;
        if(!dayMap[dw])dayMap[dw]={sum:0,n:0,up:0};
        dayMap[dw].sum+=ch;dayMap[dw].n++;if(ch>0)dayMap[dw].up++;
    }
    const hours=[];
    for(let h=0;h<24;h++){
        const m=hourMap[h];
        if(m&&m.n>=3)hours.push({hour:h,avgChange:m.sum/m.n,upRate:m.up/m.n*100,n:m.n});
        else hours.push({hour:h,avgChange:0,upRate:50,n:0});
    }
    const days=[];
    const dayNames=['일','월','화','수','목','금','토'];
    for(let dy=0;dy<7;dy++){
        const m=dayMap[dy];
        if(m&&m.n>=2)days.push({day:dy,name:dayNames[dy],avgChange:m.sum/m.n,upRate:m.up/m.n*100,n:m.n});
        else days.push({day:dy,name:dayNames[dy],avgChange:0,upRate:50,n:0});
    }
    return{hours,days};
}

// 2) ATR + 모멘텀 기반 향후 N봉 가격 범위 예측
function predictPriceRange(d,horizon=6){
    if(d.length<30)return null;
    const last=d[d.length-1];
    const price=last.close;
    const atr=calcATR(d,14);
    if(!atr)return null;

    // 추세 모멘텀 (최근 10봉 평균 변동률) — 분모 0 가드
    const recentChg=[];
    for(let i=Math.max(1,d.length-10);i<d.length;i++){
        const prevC=d[i-1].close;
        if(prevC>0)recentChg.push((d[i].close-prevC)/prevC);
    }
    const avgMomentum=recentChg.length?recentChg.reduce((a,b)=>a+b,0)/recentChg.length:0;

    // EMA 기울기로 방향 가중 (calcEMA는 '종가 숫자 배열'을 받아 '숫자 배열'을 반환 — 캔들 객체 X)
    const ema20=calcEMA(d.map(x=>x.close),20);
    let dirBias=0;
    if(ema20.length>=10){
        const a=ema20[ema20.length-1],b=ema20[ema20.length-10];
        if(b>0&&isFinite(a)&&isFinite(b))dirBias=(a-b)/b; // 양수=상승, 음수=하락
    }

    // 향후 horizon 봉 예상 중심가 = 현재가 * (1 + (모멘텀+기울기)/2 * horizon * 0.6)
    const projShift=(avgMomentum+dirBias)/2*horizon*0.6;
    const centerPrice=price*(1+projShift);

    // 변동성 채널 = ATR * sqrt(horizon)
    const volBand=atr*Math.sqrt(horizon);
    const upper=centerPrice+volBand;
    const lower=centerPrice-volBand;

    // 방향 확률 (모멘텀 강도 기반)
    const totalMag=Math.abs(avgMomentum)+Math.abs(dirBias);
    let upProb=50;
    if(totalMag>0){
        const bullStrength=(Math.max(0,avgMomentum)+Math.max(0,dirBias))/(totalMag+0.0001);
        upProb=Math.round(50+(bullStrength-0.5)*60); // 20~80%로 캡
    }
    upProb=Math.max(20,Math.min(80,upProb));

    // 최종 NaN/Infinity 방어 — 하나라도 비정상이면 예측 무효(null)
    if(![centerPrice,upper,lower,volBand,projShift].every(isFinite))return null;

    return{
        center:centerPrice,upper,lower,
        upProb,downProb:100-upProb,
        currentPrice:price,
        expectedReturn:projShift*100,
        volatility:price>0?volBand/price*100:0,
        horizon,
    };
}

// 3) 다음 풀롱/풀숏 트리거 카운트다운
//    현재 점수 → 임계값(롱34/숏34) 도달까지 모멘텀 기반 추정
function predictNextSignal(d,currentScore){
    if(!currentScore||d.length<5)return null;
    const{longConds,shortConds,totalConds}=currentScore;
    const threshold=Math.round(totalConds*0.5); // 약 50% = 풀롱/풀숏 트리거

    // 최근 5봉간 점수 변화율을 추정하기 위해 N봉씩 거슬러 시뮬레이션
    const scores=[];
    for(let back=4;back>=0;back--){
        const idx=d.length-1-back;
        if(idx<30)continue;
        const sub=d.slice(0,idx+1);
        // 간이 시그널 추정: 직접 호출하지 않고 RSI/MACD 트렌드만 보고 점수 추정
        const rsi=calcRSI(sub,14);
        const r=rsi.length?rsi[rsi.length-1].value:50;
        const ma20=calcSMA(sub,20),ma100=calcSMA(sub,100);
        const m20=ma20.length?ma20[ma20.length-1].value:sub[sub.length-1].close;
        const m100=ma100.length?ma100[ma100.length-1].value:sub[sub.length-1].close;
        const price=sub[sub.length-1].close;
        // 단순 점수 (롱: RSI<50 + price>MA, 숏: RSI>50 + price<MA)
        let lScore=0,sScore=0;
        if(r<40)lScore+=10;else if(r<50)lScore+=5;
        if(r>60)sScore+=10;else if(r>50)sScore+=5;
        if(price>m20)lScore+=8;if(price<m20)sScore+=8;
        if(m20>m100)lScore+=8;if(m20<m100)sScore+=8;
        scores.push({l:lScore,s:sScore});
    }
    if(scores.length<3)return null;

    // 모멘텀 = 최근 점수 - 이전 점수 (봉당 변화율)
    const lDelta=(scores[scores.length-1].l-scores[0].l)/(scores.length-1);
    const sDelta=(scores[scores.length-1].s-scores[0].s)/(scores.length-1);

    const isLongBias=longConds>shortConds;
    const score=isLongBias?longConds:shortConds;
    const delta=isLongBias?lDelta:sDelta;
    const remain=threshold-score;

    if(delta<=0||remain<=0){
        return{
            type:isLongBias?'풀롱':'풀숏',
            score,threshold,remaining:remain,
            barsToTrigger:remain<=0?0:null,
            estimate:remain<=0?'이미 트리거 임박':'모멘텀 약함 (추세 반전 필요)',
        };
    }
    const bars=Math.ceil(remain/Math.max(1,delta));
    return{
        type:isLongBias?'풀롱':'풀숏',
        score,threshold,remaining:remain,
        barsToTrigger:bars,
        deltaPerBar:delta.toFixed(1),
    };
}

// 4) RSI 사이클 감지 - 다음 추세 전환 시점 추정
function detectMarketCycle(d){
    if(d.length<60)return null;
    const rsi=calcRSI(d,14);
    if(rsi.length<40)return null;

    // 최근 50봉에서 RSI > 70 또는 < 30 지점 찾기
    const peaks=[],troughs=[];
    for(let i=2;i<rsi.length-2;i++){
        const r=rsi[i].value;
        const r1=rsi[i-1].value,r2=rsi[i-2].value;
        const r3=rsi[i+1].value,r4=rsi[i+2].value;
        if(r>r1&&r>r2&&r>r3&&r>r4&&r>60)peaks.push({idx:i,value:r,time:rsi[i].time});
        if(r<r1&&r<r2&&r<r3&&r<r4&&r<40)troughs.push({idx:i,value:r,time:rsi[i].time});
    }
    if(peaks.length<2&&troughs.length<2)return null;

    // 사이클 주기 (peak~peak 평균 봉수)
    let avgPeakCycle=null,avgTroughCycle=null;
    if(peaks.length>=2){
        const diffs=[];for(let i=1;i<peaks.length;i++)diffs.push(peaks[i].idx-peaks[i-1].idx);
        avgPeakCycle=Math.round(diffs.reduce((a,b)=>a+b,0)/diffs.length);
    }
    if(troughs.length>=2){
        const diffs=[];for(let i=1;i<troughs.length;i++)diffs.push(troughs[i].idx-troughs[i-1].idx);
        avgTroughCycle=Math.round(diffs.reduce((a,b)=>a+b,0)/diffs.length);
    }
    const lastIdx=rsi.length-1;
    const lastPeak=peaks.length?peaks[peaks.length-1]:null;
    const lastTrough=troughs.length?troughs[troughs.length-1]:null;

    let nextEvent=null;
    if(avgPeakCycle&&lastPeak){
        const since=lastIdx-lastPeak.idx;
        const remain=avgPeakCycle-since;
        if(remain>0&&remain<avgPeakCycle*1.5){
            nextEvent={type:'peak',barsRemain:remain,desc:'다음 RSI 고점(과매수) 예상'};
        }
    }
    if(avgTroughCycle&&lastTrough){
        const since=lastIdx-lastTrough.idx;
        const remain=avgTroughCycle-since;
        if(remain>0&&remain<avgTroughCycle*1.5){
            if(!nextEvent||remain<nextEvent.barsRemain)
                nextEvent={type:'trough',barsRemain:remain,desc:'다음 RSI 저점(과매도) 예상'};
        }
    }
    return{avgPeakCycle,avgTroughCycle,lastPeak:lastPeak?lastIdx-lastPeak.idx:null,lastTrough:lastTrough?lastIdx-lastTrough.idx:null,nextEvent};
}

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
            const status=g.filled?'필링됨':'미필링';
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

// ─── 강화된 오더블록 매물대 감지: 신선도 + 볼륨 + 임펄스 + 클러스터링 ───
// 반환: [{type, priceLow, priceHigh, volume, impulse, strength(0~6), untested, idx}]
function detectOrderBlocksAdvanced(d){
    if(d.length<30)return[];
    const raw=[];
    const start=Math.max(2,d.length-120);
    for(let i=start;i<d.length-2;i++){
        const c=d[i],n=d[i+1];
        // Bullish OB: 음봉 + 다음 양봉이 고점 돌파
        if(c.close<c.open&&n.close>n.open&&n.close>c.high){
            raw.push({
                type:'bullish_ob',
                priceLow:Math.min(c.close,c.open*0.999), // OB zone 하단
                priceHigh:c.open,                         // OB zone 상단
                time:c.time,volume:c.volume||0,idx:i,
                impulse:(n.close-c.high)/c.high,
            });
        }
        // Bearish OB: 양봉 + 다음 음봉이 저점 깨짐
        if(c.close>c.open&&n.close<n.open&&n.close<c.low){
            raw.push({
                type:'bearish_ob',
                priceLow:c.open,
                priceHigh:Math.max(c.close,c.open*1.001),
                time:c.time,volume:c.volume||0,idx:i,
                impulse:(c.low-n.close)/c.low,
            });
        }
    }
    if(!raw.length)return[];
    const avgVol=d.slice(-50).reduce((a,c)=>a+(c.volume||0),0)/Math.max(1,Math.min(50,d.length));
    raw.forEach(ob=>{
        let s=0;
        // 1) 볼륨 강도 (평균 대비)
        if(avgVol>0){
            if(ob.volume>avgVol*2)s+=3;
            else if(ob.volume>avgVol*1.5)s+=2;
            else if(ob.volume>avgVol)s+=1;
        }
        // 2) 임펄스 강도 (다음 봉 돌파 폭)
        if(ob.impulse>0.03)s+=2;
        else if(ob.impulse>0.015)s+=1;
        // 3) 신선도 (이후 OB zone에 다시 침범한 적 없는가)
        let untested=true;
        for(let j=ob.idx+2;j<d.length;j++){
            const dj=d[j];
            if(ob.type==='bullish_ob'&&dj.low<ob.priceLow*0.998){untested=false;break;}
            if(ob.type==='bearish_ob'&&dj.high>ob.priceHigh*1.002){untested=false;break;}
        }
        if(untested)s+=2;
        ob.strength=s;
        ob.untested=untested;
    });
    // 강도 높은 순 정렬, 상위 8개
    return raw.sort((a,b)=>b.strength-a.strength).slice(0,8);
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
        reasons.push(`${p.type==='long'?'[L]':'[S]'} ${p.name}`);
    });

    // 2) RSI 신호
    const rsi=calcRSI(d,14);
    if(rsi.length){
        const rv=rsi[rsi.length-1].value;
        if(rv<30){longScore+=40;reasons.push('RSI 과매도('+rv.toFixed(0)+')');}
        else if(rv<40){longScore+=15;reasons.push('RSI 약세구간('+rv.toFixed(0)+')');}
        else if(rv>70){shortScore+=40;reasons.push('RSI 과매수('+rv.toFixed(0)+')');}
        else if(rv>60){shortScore+=15;reasons.push('RSI 강세과열('+rv.toFixed(0)+')');}
    }

    // 3) MACD 신호
    const macd=calcMACD(d);
    if(macd.hist.length>=2){
        const h1=macd.hist[macd.hist.length-2].value;
        const h2=macd.hist[macd.hist.length-1].value;
        if(h1<0&&h2>0){longScore+=50;reasons.push('MACD 골든크로스');}
        if(h1>0&&h2<0){shortScore+=50;reasons.push('MACD 데드크로스');}
        if(h2>0&&h2>h1){longScore+=10;reasons.push('MACD 히스토그램↑');}
        if(h2<0&&h2<h1){shortScore+=10;reasons.push('MACD 히스토그램↓');}
    }

    // 4) MA 배열 신호
    const ma7=calcSMA(d,7),ma20=calcSMA(d,20),ma100=calcSMA(d,100);
    if(ma7.length&&ma20.length&&ma100.length){
        const m7=ma7[ma7.length-1].value,m20=ma20[ma20.length-1].value,m100=ma100[ma100.length-1].value;
        if(price>m7&&m7>m20&&m20>m100){longScore+=30;reasons.push('MA 정배열');}
        if(price<m7&&m7<m20&&m20<m100){shortScore+=30;reasons.push('MA 역배열');}
        if(price>m7&&price<m20){reasons.push('⚪ MA7 위, MA20 아래');}
    }

    // 5) 거래량 확인
    if(d.length>=20){
        const avgVol=d.slice(-20,-1).reduce((s,c)=>s+c.volume,0)/19;
        const lastVol=d[d.length-1].volume;
        if(lastVol>avgVol*1.5){
            if(d[d.length-1].close>d[d.length-1].open){longScore+=20;reasons.push('거래량 급증+양봉');}
            else{shortScore+=20;reasons.push('거래량 급증+음봉');}
        }
    }

    // 6) CCI
    const cci=calcCCI(d,20);
    if(cci!==null){
        if(cci<-100){longScore+=15;reasons.push('CCI 과매도');}
        if(cci>100){shortScore+=15;reasons.push('CCI 과매수');}
    }

    // 7) Williams %R
    const wr=calcWilliamsR(d,14);
    if(wr!==null){
        if(wr<-80){longScore+=15;reasons.push('W%R 과매도');}
        if(wr>-20){shortScore+=15;reasons.push('W%R 과매수');}
    }

    // 8) RSI 다이버전스 (코인의 바이블 기법)
    const rsiDiv=detectRSIDivergence(d,rsi);
    rsiDiv.forEach(s=>{
        if(s.type==='bullish_div'){longScore+=s.strength;reasons.push('RSI 상승다이버전스');}
        if(s.type==='bearish_div'){shortScore+=s.strength;reasons.push('RSI 하락다이버전스');}
    });

    // 9) 유동성 스윕 (비트코인 일루미나티 기법)
    const sweeps=detectLiquiditySweep(d,20);
    if(sweeps.length){
        const last=sweeps[sweeps.length-1];
        if(last.type==='bullish_sweep'&&d[d.length-1].time-last.time<86400*3){
            longScore+=50;reasons.push('저점 유동성스윕(반전)');}
        if(last.type==='bearish_sweep'&&d[d.length-1].time-last.time<86400*3){
            shortScore+=50;reasons.push('고점 유동성스윕(반전)');}
    }

    // 10) 와이코프 VSA
    const wyckoff=detectWyckoff(d);
    wyckoff.forEach(w=>{
        if(w.type==='wyckoff_spring'){longScore+=w.strength;reasons.push('와이코프 스프링(축적)');}
        if(w.type==='wyckoff_upthrust'){shortScore+=w.strength;reasons.push('와이코프 업스러스트(분배)');}
    });

    // 11) FVG (비트코인 일루미나티 기법)
    const fvgs=detectFVG(d);
    if(fvgs.length){
        const last=fvgs[fvgs.length-1];
        const p=d[d.length-1].close;
        if(last.type==='bullish_fvg'&&p<=last.top&&p>=last.bottom){
            longScore+=40;reasons.push('상승 FVG 영역 진입');}
        if(last.type==='bearish_fvg'&&p>=last.bottom&&p<=last.top){
            shortScore+=40;reasons.push('하락 FVG 영역 진입');}
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
    reasonEl.textContent=reasons.slice(0,8).map(r=>r.replace(/\[L\]|\[S\]|🟢|🔴|⚪/g,'').trim()).join(' | ');
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
let offscreenOverlay=null,overlayCtx=null;
let cachedCMEGaps=null,lastCMEGapFetchTime=0;

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
    const w2=wrap.clientWidth*2,h2=wrap.clientHeight*2;
    if(cv.width!==w2||cv.height!==h2){cv.width=w2;cv.height=h2;cv.style.width=wrap.clientWidth+'px';cv.style.height=wrap.clientHeight+'px';}
    if(!offscreenOverlay)offscreenOverlay=document.createElement('canvas');
    if(offscreenOverlay.width!==w2||offscreenOverlay.height!==h2){offscreenOverlay.width=w2;offscreenOverlay.height=h2;}
    return cv;
}

async function updateLiqLevels(){
    if(isStock(currentSymbol))return; // 주식 모드: 청산 히트맵 없음
    try{
        const d=await fetchLiquidationData(currentSymbol);
        const cv=ensureLiqOverlay();
        if(!cv||!lastKlineData.length)return;
        const ctx=overlayCtx||cv.getContext('2d');
        if(!overlayCtx)ctx.clearRect(0,0,cv.width,cv.height);

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

        // 5) CME 갭 영역 시각화 (캐시 사용, 60초마다 갱신)
        try{
            const now=Date.now();
            if(!cachedCMEGaps||now-lastCMEGapFetchTime>60000){try{cachedCMEGaps=await fetchCMEGaps(currentSymbol);lastCMEGapFetchTime=now;}catch(e){}}
            (cachedCMEGaps||[]).filter(g=>!g.filled).forEach(g=>{
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
   풀롱/풀숏 가격대 표시 (모든 지표 총동원)
   BB, Fib, MA, S/R, 청산클러스터, VWAP, ATR 기반
   ═══════════════════════════════════ */
function drawFullSignalZones(){
    const d=lastKlineData;
    if(!d||d.length<100)return;
    const cv=document.getElementById('liqHeatmapOverlay');
    if(!cv)return;
    const ctx=overlayCtx||cv.getContext('2d');
    const W=cv.width,H=cv.height;
    const rightPad=W*0.06;
    const priceToY=(p)=>{const c=candleSeries.priceToCoordinate(p);return c!==null?c*2:null;};
    const price=d[d.length-1].close;

    // ── 모든 지표에서 주요 가격대 수집 ──
    const longZones=[]; // {price, score, label}
    const shortZones=[];

    // 1) Bollinger Bands
    const bb=calcBollingerBands(d,20,2);
    if(bb){
        longZones.push({price:bb.lower,score:25,label:'BB 하단'});
        shortZones.push({price:bb.upper,score:25,label:'BB 상단'});
        longZones.push({price:bb.middle,score:10,label:'BB 중간'});
    }

    // 2) 이동평균선
    const ma7=calcSMA(d,7),ma20=calcSMA(d,20),ma100=calcSMA(d,100),ma200=calcSMA(d,200);
    if(ma20.length){const v=ma20[ma20.length-1].value; if(v<price)longZones.push({price:v,score:20,label:'MA20'}); else shortZones.push({price:v,score:20,label:'MA20'});}
    if(ma100.length){const v=ma100[ma100.length-1].value; if(v<price)longZones.push({price:v,score:25,label:'MA100'}); else shortZones.push({price:v,score:25,label:'MA100'});}
    if(ma200.length){const v=ma200[ma200.length-1].value; if(v<price)longZones.push({price:v,score:30,label:'MA200'}); else shortZones.push({price:v,score:30,label:'MA200'});}

    // 3) 피보나치 되돌림
    const fibs=calcFibonacci(d);
    fibs.forEach(f=>{
        if(f.level>=0.382&&f.level<=0.786){
            if(f.price<price)longZones.push({price:f.price,score:15+f.level*20,label:`Fib ${f.label}`});
            else shortZones.push({price:f.price,score:15+f.level*20,label:`Fib ${f.label}`});
        }
    });

    // 4) VWAP
    const vwap=calcVWAP(d.slice(-50));
    if(vwap>0){
        if(vwap<price)longZones.push({price:vwap,score:20,label:'VWAP'});
        else shortZones.push({price:vwap,score:20,label:'VWAP'});
    }

    // 5) ATR 기반 타겟
    const atr=calcATR(d,14);
    if(atr){
        longZones.push({price:price-atr*1.5,score:15,label:'ATR 지지'});
        shortZones.push({price:price+atr*1.5,score:15,label:'ATR 저항'});
    }

    // 6) 지지/저항선 (피벗 클러스터)
    const pvts=findPivots(d,5,5);
    const tolerance=price*0.003;
    const allLevels=[];
    pvts.highs.forEach(h=>allLevels.push({price:h.price,type:'R'}));
    pvts.lows.forEach(l=>allLevels.push({price:l.price,type:'S'}));
    const clusters=[];
    for(const lv of allLevels){
        let found=false;
        for(const c of clusters){if(Math.abs(c.price-lv.price)<tolerance){c.touches++;c.price=(c.price*(c.touches-1)+lv.price)/c.touches;found=true;break;}}
        if(!found)clusters.push({price:lv.price,touches:1,type:lv.price>price?'R':'S'});
    }
    clusters.filter(c=>c.touches>=2).forEach(c=>{
        const sc=c.touches*10;
        if(c.type==='S')longZones.push({price:c.price,score:sc,label:`지지(${c.touches})`});
        else shortZones.push({price:c.price,score:sc,label:`저항(${c.touches})`});
    });

    // 7) 청산 클러스터 (실데이터 호가창 기반만 사용. lastLiquidationData가 실데이터)
    //    ⚠️ 결정론적 추정(빈 호가창)은 제거 - 실제 호가창 데이터 있을 때만 반영
    try{
        const liqData=lastLiquidationData;
        if(liqData&&liqData.real_data){
            const liqPrices=liqData.price_levels;
            const longLiqs=liqData.long_liquidations;
            const shortLiqs=liqData.short_liquidations;
            let maxLongIdx=0;longLiqs.forEach((v,i)=>{if(v>longLiqs[maxLongIdx])maxLongIdx=i;});
            if(longLiqs[maxLongIdx]>30&&liqPrices[maxLongIdx]<price)shortZones.push({price:liqPrices[maxLongIdx],score:15,label:'매물벽(롱청산)'});
            let maxShortIdx=0;shortLiqs.forEach((v,i)=>{if(v>shortLiqs[maxShortIdx])maxShortIdx=i;});
            if(shortLiqs[maxShortIdx]>30&&liqPrices[maxShortIdx]>price)longZones.push({price:liqPrices[maxShortIdx],score:15,label:'매물벽(숏청산)'});
        }
    }catch(e){}

    // 8) 이치모쿠 클라우드
    const ich=calcIchimoku(d);
    if(ich.senkouA.length&&ich.senkouB.length){
        const sa=ich.senkouA[ich.senkouA.length-1].value;
        const sb=ich.senkouB[ich.senkouB.length-1].value;
        const cloudTop=Math.max(sa,sb),cloudBot=Math.min(sa,sb);
        if(cloudBot<price)longZones.push({price:cloudBot,score:20,label:'이치모쿠 구름하단'});
        if(cloudTop>price)shortZones.push({price:cloudTop,score:20,label:'이치모쿠 구름상단'});
    }

    // 9) RSI 기반 예상 반전가 (과매도/과매수 도달 예상가)
    const rsiData=calcRSI(d,14);
    if(rsiData.length>=2){
        const curRsi=rsiData[rsiData.length-1].value;
        // RSI가 30까지 떨어지려면 대략 얼마나 더 하락해야 하는지 추정
        if(curRsi>35&&curRsi<70){
            const rsiDropNeeded=curRsi-30;
            const recentDrop=d.slice(-14);
            const avgMove=recentDrop.reduce((s,c)=>s+Math.abs(c.close-c.open),0)/14;
            const estDropPrice=price-avgMove*rsiDropNeeded*0.3;
            if(estDropPrice>price*0.9)longZones.push({price:estDropPrice,score:15,label:`RSI30 예상`});
        }
        if(curRsi>30&&curRsi<65){
            const rsiRiseNeeded=70-curRsi;
            const recentMove=d.slice(-14);
            const avgMove=recentMove.reduce((s,c)=>s+Math.abs(c.close-c.open),0)/14;
            const estRisePrice=price+avgMove*rsiRiseNeeded*0.3;
            if(estRisePrice<price*1.1)shortZones.push({price:estRisePrice,score:15,label:`RSI70 예상`});
        }
    }

    // ── 가격대 클러스터링: 가까운 가격대 합산 ──
    const clusterZones=(zones,type)=>{
        zones.sort((a,b)=>a.price-b.price);
        const merged=[];
        for(const z of zones){
            let found=false;
            for(const m of merged){
                if(Math.abs(m.price-z.price)/price<0.005){ // 0.5% 이내 = 같은 존
                    m.score+=z.score;
                    m.labels.push(z.label);
                    m.price=(m.price+z.price)/2; // 평균가
                    found=true;break;
                }
            }
            if(!found)merged.push({price:z.price,score:z.score,labels:[z.label],type});
        }
        return merged.sort((a,b)=>b.score-a.score);
    };

    const longMerged=clusterZones(longZones,'long').slice(0,5); // 상위 5개
    const shortMerged=clusterZones(shortZones,'short').slice(0,5);
    const maxScore=Math.max(...longMerged.map(z=>z.score),...shortMerged.map(z=>z.score),1);

    // ── 차트에 가격대 존 그리기 ──
    const recent=d.slice(-80);
    const visHigh=Math.max(...recent.map(c=>c.high))*1.02;
    const visLow=Math.min(...recent.map(c=>c.low))*0.98;

    const drawZone=(zone,idx)=>{
        if(zone.price<visLow||zone.price>visHigh)return;
        const y=priceToY(zone.price);
        if(y===null)return;
        const isLong=zone.type==='long';
        const intensity=Math.min(1,zone.score/maxScore);
        const baseColor=isLong?[255,215,0]:[255,105,180]; // 금색/보라색

        // 배경 존 (반투명 영역)
        ctx.save();
        ctx.fillStyle=`rgba(${baseColor.join(',')},${0.06+intensity*0.12})`;
        const zoneH=Math.max(12,intensity*30);
        ctx.fillRect(W*0.15,y-zoneH/2,W*0.7,zoneH);

        // 점선 가격대
        ctx.strokeStyle=`rgba(${baseColor.join(',')},${0.4+intensity*0.4})`;
        ctx.lineWidth=1+intensity*2;
        ctx.setLineDash([6,3]);
        ctx.beginPath();
        ctx.moveTo(W*0.12,y);
        ctx.lineTo(W-rightPad,y);
        ctx.stroke();

        // 라벨 (우측)
        ctx.font='bold 24px sans-serif';
        ctx.textAlign='right';
        ctx.fillStyle=`rgba(${baseColor.join(',')},${0.8+intensity*0.2})`;
        const tag=intensity>=0.5?(isLong?'풀롱':'풀숏'):(isLong?'롱':'숏');
        const labelsStr=zone.labels.slice(0,3).join('+');
        ctx.fillText(`${tag} ${fp(zone.price)} [${labelsStr}]`,W-rightPad-8,y-8);

        // 점수 바
        ctx.font='bold 15px sans-serif';
        ctx.fillStyle=`rgba(${baseColor.join(',')},0.7)`;
        ctx.fillText(`강도: ${zone.score}점`,W-rightPad-8,y+18);

        ctx.restore();
    };

    longMerged.forEach((z,i)=>drawZone(z,i));
    shortMerged.forEach((z,i)=>drawZone(z,i));
}

/* ───── 차트 오버레이 더블 버퍼링 렌더러 (깜빡임 방지) ───── */
async function renderChartOverlay(){
    const cv=ensureLiqOverlay();
    if(!cv||!lastKlineData.length)return;
    const w=cv.width,h=cv.height;
    if(offscreenOverlay.width!==w||offscreenOverlay.height!==h){offscreenOverlay.width=w;offscreenOverlay.height=h;}
    overlayCtx=offscreenOverlay.getContext('2d');
    overlayCtx.clearRect(0,0,w,h);
    try{await updateLiqLevels();}catch(e){}
    try{drawFullSignalZones();}catch(e){}
    // 원자적 스왑: 오프스크린 → 가시 캔버스 (한번에 복사하여 깜빡임 제거)
    const vctx=cv.getContext('2d');
    vctx.clearRect(0,0,w,h);
    vctx.drawImage(offscreenOverlay,0,0);
    overlayCtx=null;
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
        if(rlist.length&&isFinite(parseFloat(rlist[0].buyRatio))&&parseFloat(rlist[0].buyRatio)>0){
            const buy=parseFloat(rlist[0].buyRatio);
            const sell=parseFloat(rlist[0].sellRatio);
            lastLongShortRatio={buy,sell}; // 풀롱/풀숏용 캐시
            const pcr=(sell/buy).toFixed(3); // buy>0 보장됨 → Infinity/NaN 방지
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
    if(isStock(currentSymbol)){
        document.getElementById('tickKimchiWrap').style.display='none';
        await updateStockTicker(getYahooSym(currentSymbol));return;
    }
    document.getElementById('tickKimchiWrap').style.display='';
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
    if(isStock(currentSymbol)){
        // 주식 모드: 호가창 비활성
        const c=document.getElementById('orderbookTable');
        if(c&&!c.querySelector('.stock-placeholder'))c.innerHTML='<div class="stock-placeholder" style="text-align:center;padding:40px 10px;color:#8b949e;font-size:13px;">주식 모드에서는<br>호가창을 지원하지 않습니다</div>';
        return;
    }
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
// 청산 데이터 전역 캐시 (시그널 분석용 - 풀롱/풀숏 위험도 평가에 사용)
let lastLiquidationData=null;

/* ═══════════════════════════════════
   🎯 다중 시간프레임 우선순위 분석 (주봉→일봉→4h→1h)
   - 큰 시간프레임이 작은 시간프레임보다 더 강한 가중치
   - 모든 시간프레임이 같은 방향이면 매우 강한 신호
   ═══════════════════════════════════ */
let lastMultiTFAnalysis={tfs:{},consensus:null,ts:0};
let _mtfInflight=false;
let _lastUnifiedSignal=null; // 모든 시그널 표시의 단일 소스

// ─── 시그널 방향 안정화 (뚝심있게 유지) ───
// 방향 전환 조건: 새 방향이 10번 연속 + 기존 방향 최소 30초 유지 후
let _stableDirection={current:null,confirmedAt:0,pendingDir:null,pendingCount:0,lastSymbol:null};

function getStableSignalDirection(longConds,shortConds,fullSignalType){
    // 종목 바뀌면 리셋
    if(_stableDirection.lastSymbol!==currentSymbol){
        _stableDirection={current:null,confirmedAt:0,pendingDir:null,pendingCount:0,lastSymbol:currentSymbol};
    }
    const diff=longConds-shortConds;
    let raw;
    if(fullSignalType==='풀롱')raw='풀롱';
    else if(fullSignalType==='풀숏')raw='풀숏';
    else if(diff>=18)raw='롱';
    else if(diff<=-18)raw='숏';
    else if(diff>=8)raw='약한롱';
    else if(diff<=-8)raw='약한숏';
    else raw='관망';
    const now=Date.now();
    // raw 즉시 반영 (모든 패널 일관성). 안정성은 별도 heldSec/heldMin로 표시
    if(_stableDirection.current!==raw){
        _stableDirection.current=raw;
        _stableDirection.confirmedAt=now;
    }
    const heldFor=now-_stableDirection.confirmedAt;
    return{
        direction:raw,           // 항상 raw (즉시 일관)
        pending:null,
        pendingPct:0,
        heldMin:Math.round(heldFor/60000),
        heldSec:Math.round(heldFor/1000),
        stableLevel:heldFor>=60000?'안정':heldFor>=20000?'준안정':'변동중',
    };
}

/* ═══════════════════════════════════
   🎯 실시간 종목 픽 스캐너 (시그널 일관성 보장)
   - _evaluateTFSignalSimple 동일 사용 → 캔들차트 노란/분홍 라인과 일치
   ═══════════════════════════════════ */
let lastTopPicks={picks:[],ts:0,progress:0};
let _scannerInflight=false;

function _getScanCandidates(){
    // 우선순위 + 인기 종목 우선 (검색 dropdown items 활용)
    const PRIORITY=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','SUIUSDT','PEPEUSDT','WIFUSDT','ARBUSDT','OPUSDT','APTUSDT','SEIUSDT','TIAUSDT','NEARUSDT','INJUSDT','TRXUSDT','LTCUSDT','BCHUSDT','ETCUSDT','UNIUSDT','AAVEUSDT','RUNEUSDT','MKRUSDT','ATOMUSDT','FILUSDT'];
    const got=new Set();
    const out=[];
    // 1) 우선순위
    PRIORITY.forEach(s=>{if(!got.has(s)){got.add(s);out.push(s);}});
    // 2) hidden select에서 추가 종목 (최대 40개까지)
    try{
        const sel=document.getElementById('symbolSelect');
        if(sel){
            sel.querySelectorAll('optgroup[label="코인 선물"] option').forEach(o=>{
                if(out.length>=40)return;
                const v=o.value;
                if(!got.has(v)&&v.endsWith('USDT')&&!v.startsWith('STK:')){
                    got.add(v);out.push(v);
                }
            });
        }
    }catch(e){}
    return out;
}

// 빠른 진입/종료/손절 계산 (BB+MA+ATR 기반)
function _quickTradeLevels(candles,price,direction){
    if(!candles||candles.length<20)return null;
    const atr=calcATR(candles,14)||price*0.02;
    const ma20=calcSMA(candles,20);
    const ma20v=ma20.length?ma20[ma20.length-1].value:price;
    const bb=calcBollingerBands(candles,20,2);
    const isShort=direction==='숏'||direction==='풀숏';
    const isLong=direction==='롱'||direction==='풀롱';
    if(!isShort&&!isLong)return null;
    let entry,exit,stop;
    if(isShort){
        entry=Math.max(bb?.upper||price+atr*0.5,price+atr*0.3);
        exit=Math.min(ma20v-atr*0.5,price-atr*1.5);
        stop=entry+atr*1.2;
    }else{
        entry=Math.min(bb?.lower||price-atr*0.5,price-atr*0.3);
        exit=Math.max(ma20v+atr*0.5,price+atr*1.5);
        stop=entry-atr*1.2;
    }
    const risk=Math.abs(entry-stop);
    const reward=Math.abs(exit-entry);
    return{entry,exit,stop,rr:risk>0?(reward/risk).toFixed(2):'-'};
}

async function scanTopPicks(){
    if(_scannerInflight)return;
    _scannerInflight=true;
    try{
        const symbols=_getScanCandidates();
        const picks=[];
        const SCALE=4;
        for(let i=0;i<symbols.length;i++){
            const sym=symbols[i];
            try{
                let lc,sc,direction,dirEmoji='',price,atrPct,candles;
                if(sym===currentSymbol&&_lastUnifiedSignal){
                    const u=_lastUnifiedSignal;
                    lc=u.longConds;sc=u.shortConds;
                    candles=await bybitKline(sym,'60',200).catch(()=>null);
                    if(candles&&candles.length>=60){
                        price=candles[candles.length-1].close;
                        const atr=calcATR(candles,14)||price*0.02;
                        atrPct=(atr/price*100).toFixed(2);
                    }else{
                        price=lastKlineData?.[lastKlineData.length-1]?.close||0;
                        atrPct='-';
                    }
                    const stable=u.stableDirection;
                    if(stable){
                        const map={'풀롱':'풀롱','풀숏':'풀숏','롱':'롱','숏':'숏','약한롱':'약한롱','약한숏':'약한숏','관망':'관망'};
                        direction=map[stable.direction]||'관망';
                        if(direction==='풀롱'||direction==='풀숏')dirEmoji='⚡';
                    }else direction='관망';
                }else{
                    candles=await bybitKline(sym,'60',200);
                    if(!candles||candles.length<60)continue;
                    const sig=_evaluateTFSignalSimple(candles);
                    lc=sig.lc*SCALE;sc=sig.sc*SCALE;
                    price=candles[candles.length-1].close;
                    const atr=calcATR(candles,14)||price*0.02;
                    atrPct=(atr/price*100).toFixed(2);
                    const diff=lc-sc;
                    if(sig.type==='풀롱'){direction='풀롱';dirEmoji='⚡';}
                    else if(sig.type==='풀숏'){direction='풀숏';dirEmoji='⚡';}
                    else if(diff>=18)direction='롱';
                    else if(diff<=-18)direction='숏';
                    else if(diff>=8)direction='약한롱';
                    else if(diff<=-8)direction='약한숏';
                    else direction='관망';
                }
                // 진입 가능 여부: 풀롱/풀숏/롱/숏만 (약한+관망 제외)
                const actionable=direction==='풀롱'||direction==='풀숏'||direction==='롱'||direction==='숏';
                let levels=null,rrNum=0;
                if(actionable){
                    levels=_quickTradeLevels(candles,price,direction);
                    if(levels)rrNum=parseFloat(levels.rr)||0;
                }
                const margin=Math.abs(lc-sc);
                const totalScore=Math.max(lc,sc);
                // 신뢰도: 점수 + R:R 보너스
                const confidence=Math.round(totalScore*0.4+margin*1.2+(rrNum>=2?20:rrNum>=1.5?10:0));
                picks.push({
                    symbol:sym,price,lc,sc,direction,dirEmoji,
                    confidence,margin,totalScore,atrPct,
                    actionable,levels,
                });
            }catch(e){}
            lastTopPicks.progress=Math.round((i+1)/symbols.length*100);
            renderTopPicksCard();
            await new Promise(r=>setTimeout(r,80));
        }
        // 정렬: actionable 우선 → 풀롱/풀숏 우선 → R:R 2+ 우선 → confidence
        picks.sort((a,b)=>{
            if(a.actionable!==b.actionable)return b.actionable-a.actionable;
            const aFull=a.direction==='풀롱'||a.direction==='풀숏'?1:0;
            const bFull=b.direction==='풀롱'||b.direction==='풀숏'?1:0;
            if(aFull!==bFull)return bFull-aFull;
            const aRR=parseFloat(a.levels?.rr)||0;
            const bRR=parseFloat(b.levels?.rr)||0;
            if(Math.abs(aRR-bRR)>=0.5)return bRR-aRR;
            return b.confidence-a.confidence;
        });
        lastTopPicks={picks,ts:Date.now(),progress:100};
        renderTopPicksCard();
    }finally{_scannerInflight=false;}
}

function renderTopPicksCard(){
    const el=document.getElementById('topPicksContent');
    if(!el)return;
    const a=lastTopPicks;
    if(!a.picks||!a.picks.length){
        if(_scannerInflight){
            el.innerHTML=`<div style="color:var(--text-secondary);font-size:11px;text-align:center;padding:14px;">스캔 중... ${a.progress||0}%</div>`;
        }else{
            el.innerHTML='<div style="color:var(--text-secondary);font-size:11px;text-align:center;padding:14px;">로딩 중...</div>';
        }
        return;
    }
    // 진입 가능한 종목만 필터
    const actionablePicks=a.picks.filter(p=>p.actionable);
    const longPicks=actionablePicks.filter(p=>p.direction==='풀롱'||p.direction==='롱').slice(0,5);
    const shortPicks=actionablePicks.filter(p=>p.direction==='풀숏'||p.direction==='숏').slice(0,5);
    const isMobile=window.innerWidth<=768;

    // 모바일: 컴팩트 카드 형태
    function rowMobile(p,isLong){
        const color=isLong?'#FFD700':'#FF69B4';
        const isFullSignal=p.direction==='풀롱'||p.direction==='풀숏';
        const dirBg=isFullSignal?color:'transparent';
        const dirColor=p.direction==='풀롱'?'#000':p.direction==='풀숏'?'#fff':color;
        const lv=p.levels||{};
        const rrColor=parseFloat(lv.rr)>=2?'#00d26a':parseFloat(lv.rr)>=1.5?'#FFD700':parseFloat(lv.rr)>=1?'#ff9f43':'#ff4757';
        return `<div style="padding:5px 6px;border-bottom:1px solid rgba(255,255,255,0.05);${isFullSignal?'background:rgba('+(isLong?'255,215,0':'255,105,180')+',0.08);':''}">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:3px;">
                <span style="color:#58a6ff;font-weight:700;font-size:11px;" onclick="document.getElementById('symbolSelect').value='${p.symbol}';document.getElementById('symbolSelect').dispatchEvent(new Event('change',{bubbles:true}));">${p.symbol}</span>
                <span style="padding:1px 5px;border-radius:50px;background:${dirBg};color:${dirColor};border:1px solid ${color};font-size:8px;font-weight:700;">${p.dirEmoji}${p.direction}</span>
                <span style="color:${rrColor};font-weight:700;font-size:10px;">R:R ${lv.rr||'-'}</span>
            </div>
            <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:2px;font-size:9px;line-height:1.25;">
                <div><span style="color:var(--text-secondary);font-size:8px;">현재</span><br><span style="font-family:monospace;">${fp(p.price)}</span></div>
                <div><span style="color:${color};font-size:8px;">진입</span><br><span style="color:${color};font-family:monospace;">${lv.entry?fp(lv.entry):'-'}</span></div>
                <div><span style="color:${isLong?'#FF69B4':'#FFD700'};font-size:8px;">종료</span><br><span style="color:${isLong?'#FF69B4':'#FFD700'};font-family:monospace;">${lv.exit?fp(lv.exit):'-'}</span></div>
                <div><span style="color:#ff4757;font-size:8px;">손절</span><br><span style="color:#ff4757;font-family:monospace;">${lv.stop?fp(lv.stop):'-'}</span></div>
            </div>
        </div>`;
    }

    if(isMobile){
        // 모바일: TOP 3씩, 1열 카드
        const lTop=longPicks.slice(0,3);
        const sTop=shortPicks.slice(0,3);
        el.innerHTML=`
            <div style="display:grid;grid-template-columns:1fr;gap:6px;">
                <div>
                    <div style="color:#FFD700;font-weight:700;font-size:10px;margin-bottom:3px;border-left:3px solid #FFD700;padding-left:6px;">롱 TOP 3 - 진입 가능</div>
                    <div>${lTop.length?lTop.map(p=>rowMobile(p,true)).join(''):'<div style="padding:8px;text-align:center;color:var(--text-secondary);font-size:9px;">롱 시그널 없음</div>'}</div>
                </div>
                <div>
                    <div style="color:#FF69B4;font-weight:700;font-size:10px;margin-bottom:3px;border-left:3px solid #FF69B4;padding-left:6px;">숏 TOP 3 - 진입 가능</div>
                    <div>${sTop.length?sTop.map(p=>rowMobile(p,false)).join(''):'<div style="padding:8px;text-align:center;color:var(--text-secondary);font-size:9px;">숏 시그널 없음</div>'}</div>
                </div>
            </div>
            <div style="font-size:8px;color:var(--text-secondary);text-align:right;margin-top:3px;">${actionablePicks.length}/${a.picks.length}개 · ${new Date(a.ts).toLocaleTimeString()} · <b style="color:${a.progress===100?'#00d26a':'#FFD700'}">${a.progress||100}%</b></div>
        `;
        return;
    }

    // 데스크탑: 기존 테이블
    function rowDesktop(p,isLong){
        const color=isLong?'#FFD700':'#FF69B4';
        const bgColor=isLong?'rgba(255,215,0,0.08)':'rgba(255,105,180,0.08)';
        const dirBg=p.direction==='풀롱'||p.direction==='풀숏'?color:'transparent';
        const dirColor=p.direction==='풀롱'?'#000':p.direction==='풀숏'?'#fff':color;
        const isFullSignal=p.direction==='풀롱'||p.direction==='풀숏';
        const lv=p.levels||{};
        const rrColor=parseFloat(lv.rr)>=2?'#00d26a':parseFloat(lv.rr)>=1.5?'#FFD700':parseFloat(lv.rr)>=1?'#ff9f43':'#ff4757';
        return `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);${isFullSignal?'background:'+bgColor:''}">
            <td style="padding:6px 8px;cursor:pointer;color:#58a6ff;font-weight:600;" onclick="document.getElementById('symbolSelect').value='${p.symbol}';document.getElementById('symbolSelect').dispatchEvent(new Event('change',{bubbles:true}));">${p.symbol}</td>
            <td style="padding:6px 8px;text-align:right;font-family:monospace;font-size:10px;">${fp(p.price)}</td>
            <td style="padding:6px 8px;text-align:center;"><span style="padding:1px 8px;border-radius:50px;background:${dirBg};color:${dirColor};border:1px solid ${color};font-size:10px;font-weight:700;">${p.dirEmoji}${p.direction}</span></td>
            <td style="padding:6px 8px;text-align:right;color:${color};font-family:monospace;font-size:10px;">${lv.entry?fp(lv.entry):'-'}</td>
            <td style="padding:6px 8px;text-align:right;color:${isLong?'#FF69B4':'#FFD700'};font-family:monospace;font-size:10px;">${lv.exit?fp(lv.exit):'-'}</td>
            <td style="padding:6px 8px;text-align:right;color:#ff4757;font-family:monospace;font-size:10px;">${lv.stop?fp(lv.stop):'-'}</td>
            <td style="padding:6px 8px;text-align:right;color:${rrColor};font-weight:700;">${lv.rr||'-'}</td>
            <td style="padding:6px 8px;text-align:right;color:${color};font-weight:700;">${p.confidence}</td>
        </tr>`;
    }
    const header=`<tr style="color:var(--text-secondary);font-size:9px;border-bottom:1px solid var(--border);">
        <th style="text-align:left;padding:4px 8px;">종목</th>
        <th style="text-align:right;padding:4px 8px;">현재가</th>
        <th style="text-align:center;padding:4px 8px;">방향</th>
        <th style="text-align:right;padding:4px 8px;">진입가</th>
        <th style="text-align:right;padding:4px 8px;">종료가</th>
        <th style="text-align:right;padding:4px 8px;">손절가</th>
        <th style="text-align:right;padding:4px 8px;">R:R</th>
        <th style="text-align:right;padding:4px 8px;">신뢰도</th>
    </tr>`;
    el.innerHTML=`
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div>
                <div style="color:#FFD700;font-weight:700;font-size:12px;margin-bottom:6px;border-left:3px solid #FFD700;padding-left:8px;">롱 TOP 5 - 지금 들어가도 되는 종목</div>
                <table style="width:100%;font-size:11px;border-collapse:collapse;">
                    <thead>${header}</thead>
                    <tbody>${longPicks.length?longPicks.map(p=>rowDesktop(p,true)).join(''):'<tr><td colspan="8" style="padding:14px;text-align:center;color:var(--text-secondary);font-size:11px;">진입 가능 롱 종목 없음 (모두 관망/약한 신호)</td></tr>'}</tbody>
                </table>
            </div>
            <div>
                <div style="color:#FF69B4;font-weight:700;font-size:12px;margin-bottom:6px;border-left:3px solid #FF69B4;padding-left:8px;">숏 TOP 5 - 지금 들어가도 되는 종목</div>
                <table style="width:100%;font-size:11px;border-collapse:collapse;">
                    <thead>${header}</thead>
                    <tbody>${shortPicks.length?shortPicks.map(p=>rowDesktop(p,false)).join(''):'<tr><td colspan="8" style="padding:14px;text-align:center;color:var(--text-secondary);font-size:11px;">진입 가능 숏 종목 없음 (모두 관망/약한 신호)</td></tr>'}</tbody>
                </table>
            </div>
        </div>
        <div style="font-size:9px;color:var(--text-secondary);text-align:right;margin-top:6px;">스캔 ${a.picks.length}개 중 진입가능 ${actionablePicks.length}개 · ${new Date(a.ts).toLocaleTimeString()} 갱신 · <b style="color:${a.progress===100?'#00d26a':'#FFD700'}">${a.progress||100}%</b></div>
    `;
}

// 가격 기반 지표만 사용하는 독립 평가 (외부 글로벌 의존 X, 임계값 미달이어도 점수 반환)
function _evaluateTFSignalSimple(d){
    if(!d||d.length<60)return{lc:0,sc:0,type:null};
    try{
        const c=d[d.length-1];
        const prev=d[d.length-2];
        const price=c.close;
        let lc=0,sc=0;

        // RSI (최대 4점)
        const rsiData=calcRSI(d,14);
        const rsi=rsiData[rsiData.length-1]?.value||50;
        const rsiPrev=rsiData[rsiData.length-2]?.value||50;
        if(rsi<25)lc+=3;else if(rsi<35)lc+=2;else if(rsi<45)lc+=1;
        if(rsi>75)sc+=3;else if(rsi>65)sc+=2;else if(rsi>55)sc+=1;
        if(rsi>rsiPrev)lc+=1;else sc+=1;

        // MACD (최대 4점)
        const macd=calcMACD(d);
        if(macd&&macd.hist&&macd.hist.length>=2){
            const h=macd.hist[macd.hist.length-1].value;
            const hP=macd.hist[macd.hist.length-2].value;
            if(h>0)lc+=2;else sc+=2;
            if(h>hP)lc+=2;else sc+=2;
        }

        // MA 정렬 (최대 5점)
        const ma7=calcSMA(d,7),ma20=calcSMA(d,20),ma100=calcSMA(d,100),ma200=calcSMA(d,200);
        if(ma7.length&&ma20.length&&ma100.length){
            const v7=ma7[ma7.length-1].value,v20=ma20[ma20.length-1].value,v100=ma100[ma100.length-1].value;
            if(price>v7&&v7>v20&&v20>v100)lc+=3;
            else if(price<v7&&v7<v20&&v20<v100)sc+=3;
            if(price>v20)lc+=2;else sc+=2;
        }
        if(ma200.length){
            const m200=ma200[ma200.length-1].value;
            if(price>m200*1.02)lc+=3;
            else if(price<m200*0.98)sc+=3;
        }

        // StochRSI (최대 5점)
        try{
            const st=calcStochasticRSI(d);
            if(st){
                if(st.kPrev<=st.dPrev&&st.k>st.d){
                    if(st.k<25)lc+=5;else if(st.k<50)lc+=3;else lc+=2;
                }
                if(st.kPrev>=st.dPrev&&st.k<st.d){
                    if(st.k>75)sc+=5;else if(st.k>50)sc+=3;else sc+=2;
                }
            }
        }catch(e){}

        // 볼린저 (최대 3점)
        try{
            const bb=calcBollingerBands(d,20,2);
            if(bb){
                if(prev.low<=bb.lower&&c.close>bb.lower)lc+=3;
                if(prev.high>=bb.upper&&c.close<bb.upper)sc+=3;
            }
        }catch(e){}

        // 추세 (최근 10봉 변동률, 최대 3점)
        const last10=d.slice(-10);
        if(last10.length>=10){
            const trendPct=(last10[last10.length-1].close-last10[0].close)/last10[0].close*100;
            if(trendPct>3)lc+=3;else if(trendPct>1)lc+=2;else if(trendPct>0)lc+=1;
            if(trendPct<-3)sc+=3;else if(trendPct<-1)sc+=2;else if(trendPct<0)sc+=1;
        }

        // ADX 추세 강도 (최대 3점)
        try{
            const adx=calcADX(d,14);
            if(adx&&adx.adx>25){
                if(adx.plusDI>adx.minusDI)lc+=Math.min(3,Math.round((adx.adx-25)/10)+1);
                if(adx.minusDI>adx.plusDI)sc+=Math.min(3,Math.round((adx.adx-25)/10)+1);
            }
        }catch(e){}

        // 신호 판정 (총 ~30점 가능 → 18+ 풀롱/풀숏)
        let type=null;
        if(lc>=18&&sc<7)type='풀롱';
        else if(sc>=18&&lc<7)type='풀숏';
        return{lc,sc,type};
    }catch(e){
        console.warn('TF eval err',e);
        return{lc:0,sc:0,type:null};
    }
}

async function updateMultiTimeframeAnalysis(){
    if(_mtfInflight)return;
    if(isStock(currentSymbol))return;
    _mtfInflight=true;
    const sym=currentSymbol;
    try{
        const tfs=[
            {key:'W',label:'주봉',weight:4},
            {key:'D',label:'일봉',weight:3},
            {key:'240',label:'4시간',weight:2},
            {key:'60',label:'1시간',weight:1},
        ];
        const SCALE=4; // simple eval(~30) → full(~125) 스케일 통일
        const results={};
        // 현재 차트 시간프레임 (캔들차트와 직접 비교용)
        const curTFMap={'W':'주봉','D':'일봉','240':'4시간','60':'1시간'};
        const curTFLabel=curTFMap[currentInterval]||null;
        for(const tf of tfs){
            try{
                // 현재 시간프레임이면 _lastUnifiedSignal 사용 (캔들차트와 100% 일치)
                if(tf.label===curTFLabel&&_lastUnifiedSignal){
                    const u=_lastUnifiedSignal;
                    results[tf.label]={
                        lc:u.longConds,sc:u.shortConds,
                        type:u.signal?.type||null,
                        weight:tf.weight,key:tf.key,
                        isCurrent:true,
                    };
                }else{
                    const candles=await bybitKline(sym,tf.key,500);
                    if(candles&&candles.length>=60){
                        const r=_evaluateTFSignalSimple(candles);
                        // 정규화 ×4
                        results[tf.label]={
                            lc:r.lc*SCALE,sc:r.sc*SCALE,
                            type:r.type,
                            weight:tf.weight,key:tf.key,
                            isCurrent:false,
                        };
                    }
                }
            }catch(e){}
            await new Promise(r=>setTimeout(r,250));
        }
        // 합의 계산 (정규화 점수 기준)
        let longWeight=0,shortWeight=0,totalWeight=0;
        Object.values(results).forEach(r=>{
            totalWeight+=r.weight;
            // 정규화 18*4=72 또는 풀롱/풀숏 트리거
            if(r.type==='풀롱'||(r.lc>r.sc&&(r.lc-r.sc)>=18))longWeight+=r.weight;
            else if(r.type==='풀숏'||(r.sc>r.lc&&(r.sc-r.lc)>=18))shortWeight+=r.weight;
        });
        const longPct=totalWeight?Math.round(longWeight/totalWeight*100):0;
        const shortPct=totalWeight?Math.round(shortWeight/totalWeight*100):0;
        let bias='neutral';
        if(longPct>=70)bias='strong_long';
        else if(longPct>=40)bias='long';
        else if(shortPct>=70)bias='strong_short';
        else if(shortPct>=40)bias='short';
        lastMultiTFAnalysis={
            tfs:results,
            consensus:{longPct,shortPct,bias,longWeight,shortWeight,totalWeight},
            ts:Date.now(),
        };
        renderMultiTFCard();
    }finally{_mtfInflight=false;}
}

function renderMultiTFCard(){
    const el=document.getElementById('multiTFContent');
    if(!el)return;
    const a=lastMultiTFAnalysis;
    if(!a||!a.consensus){
        el.innerHTML='<div style="color:var(--text-secondary);font-size:11px;text-align:center;padding:12px;">분석 중...</div>';
        return;
    }
    const c=a.consensus;
    const biasMap={
        strong_long:{color:'#FFD700',label:'강한 풀롱',bg:'rgba(255,215,0,0.15)'},
        long:{color:'#FFD700',label:'롱 우세',bg:'rgba(255,215,0,0.08)'},
        neutral:{color:'#888',label:'중립',bg:'rgba(255,255,255,0.05)'},
        short:{color:'#FF69B4',label:'숏 우세',bg:'rgba(255,105,180,0.08)'},
        strong_short:{color:'#FF69B4',label:'강한 풀숏',bg:'rgba(255,105,180,0.15)'},
    };
    const b=biasMap[c.bias];
    // 현재 차트의 시간프레임 매핑 (캔들차트와 일관성 표시)
    const curTFMap={'W':'주봉','D':'일봉','240':'4시간','60':'1시간'};
    const curTFLabel=curTFMap[currentInterval]||null;
    let rows='';
    const order=['주봉','일봉','4시간','1시간'];
    order.forEach(label=>{
        const r=a.tfs[label];
        const isCur=label===curTFLabel;
        const curBg=isCur?'background:rgba(88,166,255,0.08);':'';
        const curMark=isCur?'<span style="color:#58a6ff;font-size:9px;margin-left:4px;">◆ 캔들차트 동기화</span>':'';
        if(!r){rows+=`<tr style="${curBg}"><td style="padding:5px 8px;color:var(--text-secondary);">${label}${curMark}</td><td colspan="3" style="color:var(--text-secondary);font-size:10px;">-</td></tr>`;return;}
        const typeColor=r.type==='풀롱'?'#FFD700':r.type==='풀숏'?'#FF69B4':r.lc>r.sc?'#FFD700':r.sc>r.lc?'#FF69B4':'#888';
        const typeLabel=r.type||(r.lc>r.sc?'롱우세':r.sc>r.lc?'숏우세':'중립');
        rows+=`<tr style="border-bottom:1px solid rgba(255,255,255,0.05);${curBg}">
            <td style="padding:5px 8px;font-weight:600;">${label}${curMark}</td>
            <td style="padding:5px 8px;text-align:right;color:#FFD700;">롱 ${r.lc}</td>
            <td style="padding:5px 8px;text-align:right;color:#FF69B4;">숏 ${r.sc}</td>
            <td style="padding:5px 8px;text-align:right;color:${typeColor};font-weight:700;">${typeLabel}</td>
        </tr>`;
    });
    el.innerHTML=`
        <div style="background:${b.bg};border:1px solid ${b.color};padding:8px 12px;border-radius:5px;margin-bottom:8px;text-align:center;">
            <div style="color:${b.color};font-size:14px;font-weight:700;">${b.label}</div>
            <div style="font-size:10px;color:var(--text-secondary);margin-top:2px;">롱 가중 ${c.longPct}% | 숏 가중 ${c.shortPct}% (총 ${c.totalWeight}점)</div>
        </div>
        <table style="width:100%;font-size:11px;border-collapse:collapse;">
            <thead><tr style="color:var(--text-secondary);font-size:9px;border-bottom:1px solid var(--border);">
                <th style="text-align:left;padding:4px 8px;">시간프레임</th>
                <th style="text-align:right;padding:4px 8px;">롱점수</th>
                <th style="text-align:right;padding:4px 8px;">숏점수</th>
                <th style="text-align:right;padding:4px 8px;">판정</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
    `;
}

/* ═══════════════════════════════════
   🎯 다중 시간구간 청산 분석 (12h, 24h, 48h, 3d, 1w)
   - 청산 클러스터가 여러 시간구간에 걸쳐 지속되면 강력한 자석
   ═══════════════════════════════════ */
let lastMultiPeriodLiq={periods:{},ts:0};
let _mplInflight=false;

async function updateMultiPeriodLiquidation(){
    if(_mplInflight)return;
    if(isStock(currentSymbol))return;
    _mplInflight=true;
    try{
        // 각 시간구간을 대표할 1h 캔들 수 (lookback)
        const periods=[
            {label:'12h',hours:12},
            {label:'24h',hours:24},
            {label:'48h',hours:48},
            {label:'3일',hours:72},
            {label:'1주일',hours:168},
        ];
        // 청산 데이터는 현재 1개 endpoint 사용. 각 period에서 가격 변동 범위와 OI 변화를 추정해 청산 강도 평가
        const candles=await bybitKline(currentSymbol,'60',200);
        if(!candles||candles.length<50){_mplInflight=false;return;}
        const curPrice=candles[candles.length-1].close;
        const results={};
        periods.forEach(p=>{
            const slice=candles.slice(-Math.min(p.hours,candles.length));
            const high=Math.max(...slice.map(c=>c.high));
            const low=Math.min(...slice.map(c=>c.low));
            const vol=slice.reduce((s,c)=>s+(c.turnover||c.volume*c.close),0);
            // 청산 추정: 가격 범위에서 현재가까지 거리에 비례
            const longLiqProb=(curPrice-low)/curPrice; // 가격이 저점 위에 있을수록 롱 청산 잠재력 ↑
            const shortLiqProb=(high-curPrice)/curPrice;
            results[p.label]={
                high,low,volume:vol,
                longTarget:low, // 롱 청산 타겟 (저점 근처)
                shortTarget:high,// 숏 청산 타겟 (고점 근처)
                longRisk:longLiqProb*100, // %
                shortRisk:shortLiqProb*100,
            };
        });
        lastMultiPeriodLiq={periods:results,ts:Date.now()};
        renderMultiPeriodLiqCard();
    }catch(e){console.warn('multi-period liq',e);}
    finally{_mplInflight=false;}
}

function renderMultiPeriodLiqCard(){
    const el=document.getElementById('multiPeriodLiqContent');
    if(!el)return;
    const a=lastMultiPeriodLiq;
    if(!a.periods||!Object.keys(a.periods).length){
        el.innerHTML='<div style="color:var(--text-secondary);font-size:11px;text-align:center;padding:12px;">로딩 중...</div>';
        return;
    }
    let rows='';
    Object.entries(a.periods).forEach(([label,d])=>{
        const longC=d.longRisk>5?'#FFD700':'#888';
        const shortC=d.shortRisk>5?'#FF69B4':'#888';
        rows+=`<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
            <td style="padding:5px 8px;font-weight:600;">${label}</td>
            <td style="padding:5px 8px;text-align:right;color:#FF69B4;">${fp(d.longTarget)}</td>
            <td style="padding:5px 8px;text-align:right;color:${longC};">${d.longRisk.toFixed(1)}%</td>
            <td style="padding:5px 8px;text-align:right;color:#FFD700;">${fp(d.shortTarget)}</td>
            <td style="padding:5px 8px;text-align:right;color:${shortC};">${d.shortRisk.toFixed(1)}%</td>
        </tr>`;
    });
    el.innerHTML=`
        <table style="width:100%;font-size:11px;border-collapse:collapse;">
            <thead><tr style="color:var(--text-secondary);font-size:9px;border-bottom:1px solid var(--border);">
                <th style="text-align:left;padding:4px 8px;">기간</th>
                <th style="text-align:right;padding:4px 8px;">롱청산타겟</th>
                <th style="text-align:right;padding:4px 8px;">롱위험</th>
                <th style="text-align:right;padding:4px 8px;">숏청산타겟</th>
                <th style="text-align:right;padding:4px 8px;">숏위험</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <p class="hint">롱청산타겟=가격이 끌려갈 저점 / 숏청산타겟=가격이 끌려갈 고점 | 위험% 높을수록 청산 가능성↑</p>
    `;
}

/* ═══════════════════════════════════
   🎯 다중 거래소 청산 통합 (Binance + Bybit + 등)
   - 현재 Bybit + 클라이언트사이드 Binance 가격 정보 활용
   ═══════════════════════════════════ */
let lastMultiExchangeLiq={data:null,ts:0};

async function updateMultiExchangeLiquidation(){
    if(isStock(currentSymbol))return;
    const sym=currentSymbol;
    const coin=sym.replace('USDT','');
    const okxInst=coin+'-USDT-SWAP';
    try{
        // 개미(전체계정) L/S: Binance+OKX+Bybit  /  고래(상위트레이더) L/S: Binance+OKX (Bybit 미공개)
        const [biOI,biGls,biTls,okGls,okTls,byR]=await Promise.all([
            fetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=48`).then(r=>r.ok?r.json():null).catch(()=>null),
            fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=48`).then(r=>r.ok?r.json():null).catch(()=>null),
            fetch(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${sym}&period=1h&limit=48`).then(r=>r.ok?r.json():null).catch(()=>null),
            fetch(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${coin}&period=1H`).then(r=>r.ok?r.json():null).catch(()=>null),
            fetch(`https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio-contract-top-trader?instId=${okxInst}&period=1H`).then(r=>r.ok?r.json():null).catch(()=>null),
            fetch(`https://api.bybit.com/v5/market/account-ratio?category=linear&symbol=${sym}&period=1h&limit=48`).then(r=>r.ok?r.json():null).catch(()=>null),
        ]);
        const result={binance:null,bybit:lastLiquidationData};
        // OI 추이 (Binance) — 테이블/차트용 현재값 유지
        if(biOI&&Array.isArray(biOI)&&biOI.length){
            const first=parseFloat(biOI[0].sumOpenInterest);
            const last=parseFloat(biOI[biOI.length-1].sumOpenInterest);
            result.binance={oiChange:(last-first)/first*100,oiCurrent:last,
                oiSeries:biOI.map(p=>({t:parseInt(p.timestamp),oi:parseFloat(p.sumOpenInterest)}))};
        }
        if(biGls&&Array.isArray(biGls)&&biGls.length){
            const last=biGls[biGls.length-1];
            result.binance=result.binance||{};
            result.binance.longRatio=parseFloat(last.longAccount)*100;
            result.binance.shortRatio=parseFloat(last.shortAccount)*100;
            result.binance.lsRatio=parseFloat(last.longShortRatio);
        }
        if(biTls&&Array.isArray(biTls)&&biTls.length){
            result.binance=result.binance||{};
            result.binance.whaleLsRatio=parseFloat(biTls[biTls.length-1].longShortRatio);
        }
        // ── 다거래소 L/S 시간버킷 집계 ──
        const bkt=t=>Math.floor(t/3600000)*3600000;
        const mapFrom=(arr,gt,gl)=>{const m={};if(arr)for(const x of arr){const t=gt(x),v=gl(x);if(isFinite(t)&&isFinite(v)&&v>0)m[bkt(t)]=v;}return m;};
        const bnR=mapFrom(Array.isArray(biGls)?biGls:null,p=>parseInt(p.timestamp),p=>parseFloat(p.longShortRatio));
        const bnW=mapFrom(Array.isArray(biTls)?biTls:null,p=>parseInt(p.timestamp),p=>parseFloat(p.longShortRatio));
        const okR=mapFrom(okGls&&okGls.data,p=>parseInt(p[0]),p=>parseFloat(p[1]));
        const okW=mapFrom(okTls&&okTls.data,p=>parseInt(p[0]),p=>parseFloat(p[1]));
        const byRm=mapFrom(byR&&byR.result&&byR.result.list,p=>parseInt(p.timestamp),p=>parseFloat(p.buyRatio)/parseFloat(p.sellRatio));
        const baseB=Object.keys(bnR).map(Number).sort((a,b)=>a-b);
        const avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
        const retailSeries=[],whaleSeries=[];
        let retailN=0,whaleN=0;
        for(const b of baseB){
            const rv=[bnR[b],okR[b],byRm[b]].filter(v=>isFinite(v));
            const wv=[bnW[b],okW[b]].filter(v=>isFinite(v));
            retailSeries.push({t:b,ls:avg(rv)});
            whaleSeries.push({t:b,ls:avg(wv)});
            if(b===baseB[baseB.length-1]){retailN=rv.length;whaleN=wv.length;}
        }
        result.agg={retailSeries,whaleSeries,retailN,whaleN};
        lastMultiExchangeLiq={data:result,ts:Date.now()};
        renderMultiExchangeCard();
        drawBinanceWhaleCharts(result.binance,result.agg);
    }catch(e){console.warn('multi-exchange',e);}
}

// 다거래소 포지션 심리 차트 (OI 추이 + 개미/고래 L/S 비율)
let _binanceOIChartInst=null, _binanceLSChartInst=null;
function drawBinanceWhaleCharts(b,agg){
    const oiCv=document.getElementById('binanceOIChart');
    const lsCv=document.getElementById('binanceLSChart');
    const statusEl=document.getElementById('binanceWhaleStatus');
    if(!oiCv||!lsCv||typeof Chart==='undefined')return;
    if((!b||!b.oiSeries)&&(!agg||!agg.retailSeries||!agg.retailSeries.length)){
        if(statusEl)statusEl.textContent='데이터 없음 (BTC/ETH/메이저만 지원)';
        return;
    }
    // 시간 라벨 포맷
    const fmtTime=ts=>{const d=new Date(ts);return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}h`;};

    // (1) OI 추이 차트
    if(b.oiSeries&&b.oiSeries.length){
        const labels=b.oiSeries.map(p=>fmtTime(p.t));
        const oiVals=b.oiSeries.map(p=>p.oi);
        // 변화량 색깔: 마지막이 처음보다 높으면 골드(롱누적), 낮으면 핑크(청산)
        const oiUp=oiVals[oiVals.length-1]>=oiVals[0];
        const lineColor=oiUp?'#FFD700':'#FF69B4';
        const fillColor=oiUp?'rgba(255,215,0,0.10)':'rgba(255,105,180,0.10)';
        if(_binanceOIChartInst){try{_binanceOIChartInst.destroy();}catch(e){}}
        _binanceOIChartInst=new Chart(oiCv,{
            type:'line',
            data:{labels,datasets:[{
                label:'OI (계약수)',data:oiVals,
                borderColor:lineColor,backgroundColor:fillColor,
                borderWidth:1.5,pointRadius:0,fill:true,tension:0.2,
            }]},
            options:{
                responsive:true,maintainAspectRatio:false,
                plugins:{legend:{display:false},
                    tooltip:{callbacks:{label:c=>` OI: ${c.parsed.y.toLocaleString()}`}}},
                scales:{
                    x:{ticks:{color:'#8b949e',maxTicksLimit:8,font:{size:9}},grid:{color:'rgba(255,255,255,0.04)'}},
                    y:{ticks:{color:'#8b949e',font:{size:9},callback:v=>(v/1000).toFixed(0)+'K'},grid:{color:'rgba(255,255,255,0.04)'}},
                },
            },
        });
    }

    // (2) L/S 비율 추이 차트 (개미 vs 고래)
    if(agg&&agg.retailSeries&&agg.retailSeries.length&&agg.whaleSeries&&agg.whaleSeries.length){
        const labels=agg.retailSeries.map(p=>fmtTime(p.t));
        const glsVals=agg.retailSeries.map(p=>p.ls);
        const tlsVals=agg.whaleSeries.map(p=>p.ls);
        // 분석 — 마지막 값(null 아닌)으로 격차 진단
        const lastG=[...glsVals].reverse().find(v=>v!=null);
        const lastT=[...tlsVals].reverse().find(v=>v!=null);
        const gap=(lastG!=null&&lastT!=null)?lastT-lastG:0;
        let diag='';
        if(Math.abs(gap)<0.15){diag='개미/고래 의견 일치';}
        else if(gap>0.4){diag='고래 롱 우위 (개미는 보수), 상승 가능';}
        else if(gap>0.15){diag='고래가 개미보다 롱 쪽';}
        else if(gap<-0.4){diag='고래 숏 우위 (개미는 롱), 컨트래리언 하락 시그널';}
        else{diag='고래가 개미보다 숏 쪽';}
        if(statusEl){
            statusEl.innerHTML=`개미 L/S ${lastG!=null?lastG.toFixed(2):'-'} (${agg.retailN}사) / 고래 L/S ${lastT!=null?lastT.toFixed(2):'-'} (${agg.whaleN}사) · <b style="color:${gap>0.15?'#FFD700':gap<-0.15?'#FF69B4':'var(--text-primary)'};">${diag}</b>`;
        }
        if(_binanceLSChartInst){try{_binanceLSChartInst.destroy();}catch(e){}}
        _binanceLSChartInst=new Chart(lsCv,{
            type:'line',
            data:{labels,datasets:[
                {label:`개미 평균 (${agg.retailN}사: Binance·OKX·Bybit)`,data:glsVals,
                    borderColor:'#8b949e',backgroundColor:'transparent',
                    borderWidth:1.5,pointRadius:0,tension:0.2,borderDash:[4,4],spanGaps:true},
                {label:`고래 평균 (${agg.whaleN}사: Binance·OKX)`,data:tlsVals,
                    borderColor:'#22d3ee',backgroundColor:'rgba(34,211,238,0.08)',
                    borderWidth:2,pointRadius:0,fill:true,tension:0.2,spanGaps:true},
            ]},
            options:{
                responsive:true,maintainAspectRatio:false,
                plugins:{
                    legend:{display:true,position:'top',labels:{color:'#e6edf3',font:{size:10},boxWidth:12}},
                    tooltip:{callbacks:{label:c=>` ${c.dataset.label}: ${c.parsed.y.toFixed(2)}`}},
                },
                scales:{
                    x:{ticks:{color:'#8b949e',maxTicksLimit:8,font:{size:9}},grid:{color:'rgba(255,255,255,0.04)'}},
                    y:{ticks:{color:'#8b949e',font:{size:9}},grid:{color:'rgba(255,255,255,0.04)'},
                        // 1.0 (중립선) 강조용
                        afterDataLimits:scale=>{scale.min=Math.min(scale.min,0.5);scale.max=Math.max(scale.max,2);}},
                },
            },
        });
    }
}

function renderMultiExchangeCard(){
    const el=document.getElementById('multiExchangeContent');
    if(!el)return;
    const d=lastMultiExchangeLiq.data;
    if(!d){el.innerHTML='<div style="color:var(--text-secondary);font-size:11px;text-align:center;padding:12px;">로딩 중...</div>';return;}
    let html='<table style="width:100%;font-size:11px;border-collapse:collapse;">';
    html+='<thead><tr style="color:var(--text-secondary);font-size:9px;border-bottom:1px solid var(--border);"><th style="text-align:left;padding:4px 8px;">거래소</th><th style="text-align:right;padding:4px 8px;">OI 변동(24h)</th><th style="text-align:right;padding:4px 8px;">L/S 비율</th><th style="text-align:right;padding:4px 8px;">롱%</th><th style="text-align:right;padding:4px 8px;">숏%</th></tr></thead><tbody>';
    if(d.binance){
        const b=d.binance;
        const oiC=b.oiChange>0?'#FFD700':'#FF69B4';
        const lsC=b.lsRatio>1?'#FFD700':'#FF69B4';
        html+=`<tr><td style="padding:5px 8px;font-weight:600;">Binance</td>
            <td style="padding:5px 8px;text-align:right;color:${oiC};">${b.oiChange>=0?'+':''}${b.oiChange?.toFixed(2)||'-'}%</td>
            <td style="padding:5px 8px;text-align:right;color:${lsC};font-weight:700;">${b.lsRatio?.toFixed(2)||'-'}</td>
            <td style="padding:5px 8px;text-align:right;color:#FFD700;">${b.longRatio?.toFixed(1)||'-'}%</td>
            <td style="padding:5px 8px;text-align:right;color:#FF69B4;">${b.shortRatio?.toFixed(1)||'-'}%</td>
        </tr>`;
    }
    if(d.bybit){
        const totLong=(d.bybit.long_liquidations||[]).reduce((a,b)=>a+b,0);
        const totShort=(d.bybit.short_liquidations||[]).reduce((a,b)=>a+b,0);
        const ratio=totShort>0?totLong/totShort:1;
        const rC=ratio>1?'#FFD700':'#FF69B4';
        html+=`<tr><td style="padding:5px 8px;font-weight:600;">Bybit</td>
            <td style="padding:5px 8px;text-align:right;color:var(--text-secondary);">-</td>
            <td style="padding:5px 8px;text-align:right;color:${rC};font-weight:700;">${ratio.toFixed(2)}</td>
            <td style="padding:5px 8px;text-align:right;color:#FFD700;">L:${totLong.toFixed(0)}</td>
            <td style="padding:5px 8px;text-align:right;color:#FF69B4;">S:${totShort.toFixed(0)}</td>
        </tr>`;
    }
    html+='</tbody></table>';
    el.innerHTML=html;
}

async function updateLiquidation(){
    if(isStock(currentSymbol))return;
    try{
        const d=await fetchLiquidationData(currentSymbol);
        lastLiquidationData=d; // 전역 캐시 저장
        const labels=d.price_levels.map(p=>fp(p));
        if(liqChart){liqChart.data.labels=labels;liqChart.data.datasets[0].data=d.long_liquidations;liqChart.data.datasets[1].data=d.short_liquidations;liqChart.update('none');}
        else{const ctx=document.getElementById('liqChart').getContext('2d');liqChart=new Chart(ctx,{type:'bar',data:{labels,datasets:[{label:'롱 청산',data:d.long_liquidations,backgroundColor:GD,borderColor:G,borderWidth:1},{label:'숏 청산',data:d.short_liquidations,backgroundColor:RD,borderColor:R,borderWidth:1}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:true,position:'top',labels:{boxWidth:10}}},scales:{x:{...dso,stacked:true,ticks:{...dso.ticks,maxRotation:45,maxTicksLimit:8}},y:{...dso,stacked:true}}}});}
        document.querySelector('#levTable tbody').innerHTML=d.leverage_markers.map(m=>`<tr><td>${m.leverage}</td><td class="green">${fp(m.long_liq_price)}</td><td class="red">${fp(m.short_liq_price)}</td></tr>`).join('');
    }catch(e){}
}

/* ═══════════════════════════════════
   ⚠️ 청산 클러스터 위험도 평가 (Liquidation Hunt 방지)
   - 시장은 청산 클러스터로 가격을 끌어 청산을 유발 (liquidation sweep)
   - 가까운 LONG 청산 클러스터 = 풀롱 위험 (price will dump)
   - 가까운 SHORT 청산 클러스터 = 풀숏 위험 (price will pump)
   ═══════════════════════════════════ */
function analyzeLiquidationDanger(currentPrice){
    if(!lastLiquidationData||!currentPrice)return null;
    const d=lastLiquidationData;
    const prices=d.price_levels||[];
    const longLiqs=d.long_liquidations||[];
    const shortLiqs=d.short_liquidations||[];
    if(!prices.length)return null;

    // 1) 현재가 ±5% 범위 청산 클러스터 분석
    const longBelowVol=[];  // 현재가 아래 롱 청산 (가격 하락시 청산되는 롱)
    const shortAboveVol=[]; // 현재가 위 숏 청산 (가격 상승시 청산되는 숏)
    for(let i=0;i<prices.length;i++){
        const p=prices[i];
        const pct=(p-currentPrice)/currentPrice;
        if(p<currentPrice&&pct>-0.05&&longLiqs[i]>0){
            longBelowVol.push({price:p,vol:longLiqs[i],distPct:Math.abs(pct)});
        }
        if(p>currentPrice&&pct<0.05&&shortLiqs[i]>0){
            shortAboveVol.push({price:p,vol:shortLiqs[i],distPct:pct});
        }
    }
    // 2) 가장 큰 청산 클러스터 찾기
    longBelowVol.sort((a,b)=>b.vol-a.vol);
    shortAboveVol.sort((a,b)=>b.vol-a.vol);
    const maxLongBelow=longBelowVol[0]||null;
    const maxShortAbove=shortAboveVol[0]||null;

    // 3) 위험도 점수 (volume 대비 + 거리 가중)
    // 가까울수록(2% 이내), volume 클수록 위험도 높음
    function dangerScore(c){
        if(!c)return 0;
        const distBonus=c.distPct<0.01?3:c.distPct<0.02?2:c.distPct<0.035?1:0.5;
        const volBonus=c.vol>50?3:c.vol>30?2:c.vol>15?1.5:c.vol>5?1:0;
        return distBonus*volBonus;
    }

    return{
        longDanger:dangerScore(maxLongBelow), // 0~9, 클수록 풀롱 위험
        shortDanger:dangerScore(maxShortAbove), // 0~9, 클수록 풀숏 위험
        maxLongCluster:maxLongBelow,
        maxShortCluster:maxShortAbove,
        totalLongBelowVol:longBelowVol.reduce((a,b)=>a+b.vol,0),
        totalShortAboveVol:shortAboveVol.reduce((a,b)=>a+b.vol,0),
    };
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
            banner.innerHTML=`<b>${top.symbol}</b> ${top.reasons.join(' | ')} (가격: ${top.price_change>=0?'+':''}${top.price_change}%) — 총 ${alerts.length}건 감지`;
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
    if(isStock(currentSymbol)){if(ws){ws.close();ws=null;}return;} // 주식 모드: WS 불필요
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
        lastConsensusScore=score;

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
   김치프리미엄 (업비트 vs Bybit)
   ═══════════════════════════════════ */
// kimpga.com 기준: Binance 현물 가격 (클라이언트에서 직접 호출, 서버 차단 우회)
async function binanceSpotPrice(symbol){
    try{
        const r=await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`);
        if(!r.ok)return null;
        const d=await r.json();
        return parseFloat(d.price)||null;
    }catch(e){return null;}
}

// 실시간 원/달러 환율 (Dunamu=두나무, 업비트 모회사). Railway 서버는 차단되므로
// 한국 IP인 사용자 브라우저에서 직접 호출 → kimpga와 동일한 실시간 forex 사용.
let _fxRate=null,_fxRateTs=0;
async function dunamuForexRate(){
    const now=Date.now();
    if(_fxRate&&now-_fxRateTs<30000)return _fxRate; // 30초 캐시
    try{
        const r=await fetch('https://quotation-api-cdn.dunamu.com/v1/forex/recent?codes=FRX.KRWUSD');
        if(!r.ok)return _fxRate;
        const d=await r.json();
        const rate=Array.isArray(d)&&d[0]?parseFloat(d[0].basePrice):null;
        if(rate>0){_fxRate=rate;_fxRateTs=now;}
    }catch(e){}
    return _fxRate;
}

async function updateKimchiPremium(){
    if(isStock(currentSymbol))return;
    try{
        // kimpga.com 방식: Upbit KRW vs Binance 현물 USD, 실시간 forex 환율로 환산
        const [kp,binancePrice,bybitTicker,clientFx]=await Promise.all([
            fetchJSON('/api/kimchi-premium'),
            binanceSpotPrice(currentSymbol),
            bybitTickers(currentSymbol).catch(()=>null),
            dunamuForexRate(),
        ]);
        const coin=currentSymbol.replace('USDT','');
        const upbitData=kp.coins?.[coin];
        // Binance 현물 우선, 실패 시 Bybit 영구선물 fallback
        const refPrice=binancePrice||parseFloat(bybitTicker?.lastPrice||0);
        const refSource=binancePrice?'Binance':'Bybit';
        // 환율: 브라우저에서 받은 Dunamu 실시간 forex 우선, 실패 시 서버값
        const rate=clientFx||kp.usd_krw;
        const rateSrc=clientFx?'dunamu':(kp.rate_source||'?');
        const el=document.getElementById('tickKimchi');
        if(!upbitData||!refPrice||!rate){el.textContent='N/A';return;}
        // 김프 = (업비트 USD환산 - Binance USD) / Binance USD × 100
        const upbitUSD=upbitData.krw/rate;
        const premium=((upbitUSD-refPrice)/refPrice*100);
        lastKimchiPremium=premium;
        const color=premium>2?R:premium>0.5?YL:premium<-1?BL:G;
        el.textContent=(premium>=0?'+':'')+premium.toFixed(2)+'%';
        el.style.color=color;
        el.title=`업비트: ₩${upbitData.krw.toLocaleString()} | ${refSource}: $${refPrice.toLocaleString(undefined,{maximumFractionDigits:6})} | 환율: ${rate.toFixed(2)}(${rateSrc})`;
    }catch(e){document.getElementById('tickKimchi').textContent='-';}
}

/* ═══════════════════════════════════
   Etherscan 온체인 데이터 (가스·블록·ETH 흐름)
   ═══════════════════════════════════ */
let lastEthGas=null;        // {safe, propose, fast, base_fee}
let lastEthPrice=0;          // USD
let lastEthFlow=null;        // {cex_inflow_eth, cex_outflow_eth, net_flow_eth}

// ─── BTC 추세 캐시 (알트 정확도 향상용) ───
let lastBTCTrend={trend:'neutral',strength:0,slopePct:0,price:0,ts:0};

async function updateBTCTrend(){
    // BTC 자기 자신은 스킵
    if(currentSymbol==='BTCUSDT')return;
    try{
        const candles=await bybitKline('BTCUSDT','60',150);
        if(!candles||candles.length<60)return;
        const ma20=calcSMA(candles,20);
        const ma50=calcSMA(candles,50);
        if(ma20.length<10||!ma50.length)return;
        const last=candles[candles.length-1].close;
        const m20=ma20[ma20.length-1].value;
        const m50=ma50[ma50.length-1].value;
        const m20_10ago=ma20[ma20.length-10].value;
        const slope=(m20-m20_10ago)/m20_10ago*100;
        let trend='neutral',strength=0;
        if(last>m20&&m20>m50&&slope>0.3){trend='bull';strength=Math.min(2,Math.abs(slope)/0.5);}
        else if(last<m20&&m20<m50&&slope<-0.3){trend='bear';strength=Math.min(2,Math.abs(slope)/0.5);}
        lastBTCTrend={trend,strength,slopePct:slope,price:last,ts:Date.now()};
    }catch(e){console.warn('BTC trend update failed',e);}
}

/* ═══════════════════════════════════
   예측 UI 렌더링
   ═══════════════════════════════════ */
// ─── 매수/매도 추천 가격 계산 (지지/저항 + Fib + MA + BB 종합) ───
// ─── 모든 Velox 지표를 총동원해서 진입/종료 가격 산출 ───
function calculateTradeRecommendation(d,signalResult){
    if(!d||d.length<50)return null;
    const price=d[d.length-1].close;
    const atr=calcATR(d,14)||price*0.02;
    const _last=arr=>arr&&arr.length?arr[arr.length-1].value:null;

    // 1) 기본 MA / BB
    const ma7=_last(calcSMA(d,7));
    const ma20=_last(calcSMA(d,20));
    const ma50=_last(calcSMA(d,50));
    const ma100=_last(calcSMA(d,100));
    const ma200=_last(calcSMA(d,200));
    const bb=calcBollingerBands(d,20,2);

    // 2) 피벗 + Fib + 직전 저고점
    const pvts=findPivots(d,5,5);
    const recentLows=pvts.lows.slice(-5).map(p=>p.price);
    const recentHighs=pvts.highs.slice(-5).map(p=>p.price);
    const slice=d.slice(-100);
    const fibHigh=Math.max(...slice.map(c=>c.high));
    const fibLow=Math.min(...slice.map(c=>c.low));
    const fibRange=fibHigh-fibLow;

    // 3) 고급 패턴 - OB / FVG / Liquidity / Ichimoku / Harmonic
    let obAdv=[],fvgs=[],sweeps=[],ich=null,harm=null,wyckoff=null,flag=null,srLevels=[];
    try{obAdv=detectOrderBlocksAdvanced(d);}catch(e){}
    try{fvgs=detectFVG(d);}catch(e){}
    try{sweeps=detectLiquiditySweep(d,20);}catch(e){}
    try{ich=calcIchimoku(d);}catch(e){}
    try{harm=detectHarmonic(d);}catch(e){}
    try{wyckoff=detectWyckoffSpring(d,20);}catch(e){}
    try{flag=detectFlag(d);}catch(e){}
    try{srLevels=findSRLevels(d);}catch(e){}

    // 4) 다중구간 청산 타겟 (전역 캐시)
    const mpl=lastMultiPeriodLiq?.periods||{};
    // 5) 청산 위험 — 실데이터(호가창 매물벽) 있을 때만
    const liqDanger=(lastLiquidationData&&lastLiquidationData.real_data)?analyzeLiquidationDanger(price):null;

    // ───── 지지(롱 진입가 후보) 모으기 ─────
    const supports=[];
    if(bb&&bb.lower<price)supports.push({price:bb.lower,label:'BB하단',w:2});
    if(ma20&&ma20<price)supports.push({price:ma20,label:'MA20',w:2});
    if(ma50&&ma50<price)supports.push({price:ma50,label:'MA50',w:2});
    if(ma100&&ma100<price)supports.push({price:ma100,label:'MA100',w:3});
    if(ma200&&ma200<price)supports.push({price:ma200,label:'MA200',w:4});
    recentLows.forEach(p=>{if(p<price)supports.push({price:p,label:'직전저점',w:2});});
    srLevels.forEach(lv=>{if(lv<price)supports.push({price:lv,label:'S/R지지',w:3});});
    [0.236,0.382,0.5,0.618,0.786].forEach(f=>{
        const fp=fibHigh-fibRange*f;
        if(fp<price&&fp>fibLow*0.95)supports.push({price:fp,label:`Fib${(f*100).toFixed(1)}%`,w:f===0.618||f===0.5?3:2});
    });
    // 신선 OB
    obAdv.forEach(ob=>{
        if(ob.type==='bullish_ob'&&ob.priceLow<price){
            supports.push({price:ob.priceLow,label:ob.untested?'신선OB':'OB',w:ob.untested?5:3});
        }
    });
    // FVG 하단
    fvgs.forEach(fv=>{if(fv.type==='bullish_fvg'&&fv.bottom<price)supports.push({price:fv.bottom,label:'상승FVG',w:3});});
    // Liquidity Sweep (저점 스윕)
    sweeps.forEach(sw=>{if(sw.type==='bullish_sweep'&&sw.price<price)supports.push({price:sw.price,label:'저점스윕',w:4});});
    // Ichimoku 구름 하단
    if(ich&&ich.senkouA.length&&ich.senkouB.length){
        const sa=ich.senkouA[ich.senkouA.length-1].value,sb=ich.senkouB[ich.senkouB.length-1].value;
        const bot=Math.min(sa,sb);
        if(bot<price)supports.push({price:bot,label:'이치모쿠하단',w:3});
    }
    // 청산 매수 자석 (롱청산자석은 저점 자석)
    if(liqDanger?.maxLongCluster?.price<price){
        const lc=liqDanger.maxLongCluster.price;
        supports.push({price:lc,label:'청산자석(롱)',w:1}); // 위험 표시 - 가중치 낮음
    }
    // 다중구간 청산 타겟 (저점)
    Object.values(mpl).forEach(p=>{if(p.longTarget<price)supports.push({price:p.longTarget,label:'주기저점',w:2});});
    // Wyckoff Spring
    if(wyckoff?.type==='bullish_spring'){supports.push({price:price*0.99,label:'Spring영역',w:4});}

    // ───── 저항(롱 종료가 / 숏 진입가 후보) 모으기 ─────
    const resistances=[];
    if(bb&&bb.upper>price)resistances.push({price:bb.upper,label:'BB상단',w:2});
    if(ma20&&ma20>price)resistances.push({price:ma20,label:'MA20',w:2});
    if(ma50&&ma50>price)resistances.push({price:ma50,label:'MA50',w:2});
    if(ma100&&ma100>price)resistances.push({price:ma100,label:'MA100',w:3});
    if(ma200&&ma200>price)resistances.push({price:ma200,label:'MA200',w:4});
    recentHighs.forEach(p=>{if(p>price)resistances.push({price:p,label:'직전고점',w:2});});
    srLevels.forEach(lv=>{if(lv>price)resistances.push({price:lv,label:'S/R저항',w:3});});
    [0.236,0.382,0.5,0.618,0.786].forEach(f=>{
        const fp=fibLow+fibRange*f;
        if(fp>price&&fp<fibHigh*1.05)resistances.push({price:fp,label:`Fib${(f*100).toFixed(1)}%`,w:f===0.618||f===0.5?3:2});
    });
    obAdv.forEach(ob=>{
        if(ob.type==='bearish_ob'&&ob.priceHigh>price){
            resistances.push({price:ob.priceHigh,label:ob.untested?'신선OB':'OB',w:ob.untested?5:3});
        }
    });
    fvgs.forEach(fv=>{if(fv.type==='bearish_fvg'&&fv.top>price)resistances.push({price:fv.top,label:'하락FVG',w:3});});
    sweeps.forEach(sw=>{if(sw.type==='bearish_sweep'&&sw.price>price)resistances.push({price:sw.price,label:'고점스윕',w:4});});
    if(ich&&ich.senkouA.length&&ich.senkouB.length){
        const sa=ich.senkouA[ich.senkouA.length-1].value,sb=ich.senkouB[ich.senkouB.length-1].value;
        const top=Math.max(sa,sb);
        if(top>price)resistances.push({price:top,label:'이치모쿠상단',w:3});
    }
    if(liqDanger?.maxShortCluster?.price>price){
        const sc=liqDanger.maxShortCluster.price;
        resistances.push({price:sc,label:'청산자석(숏)',w:1});
    }
    Object.values(mpl).forEach(p=>{if(p.shortTarget>price)resistances.push({price:p.shortTarget,label:'주기고점',w:2});});
    if(wyckoff?.type==='bearish_upthrust'){resistances.push({price:price*1.01,label:'Upthrust영역',w:4});}

    // 가중 클러스터링: 0.5% 이내 묶고 가중치 합산
    function clusterWeighted(arr){
        arr.sort((a,b)=>a.price-b.price);
        const out=[];
        for(const it of arr){
            const found=out.find(o=>Math.abs(o.price-it.price)/price<0.005);
            if(found){
                found.labels.push(it.label);
                found.price=(found.price*found.w+it.price*it.w)/(found.w+it.w);
                found.w+=it.w;
            }else out.push({price:it.price,labels:[it.label],w:it.w});
        }
        return out.sort((a,b)=>b.w-a.w); // 가중치 높은 순
    }
    const supCl=clusterWeighted(supports);
    const resCl=clusterWeighted(resistances);

    // 시그널 방향 판정
    // 안정화된 방향 사용
    let bias='neutral',biasLabel='중립',direction='관망';
    const stable=signalResult?.stableDirection;
    if(stable){
        const d=stable.direction;
        if(d==='풀롱'){bias='strong_long';biasLabel='강한 풀롱';direction='롱';}
        else if(d==='풀숏'){bias='strong_short';biasLabel='강한 풀숏';direction='숏';}
        else if(d==='롱'){bias='long';biasLabel='롱 우세';direction='롱';}
        else if(d==='숏'){bias='short';biasLabel='숏 우세';direction='숏';}
        else if(d==='약한롱'){bias='long';biasLabel='약한 롱';direction='롱';}
        else if(d==='약한숏'){bias='short';biasLabel='약한 숏';direction='숏';}
        else{bias='neutral';biasLabel='관망';direction='관망';}
    }else if(signalResult){
        if(signalResult.signal?.type==='풀롱'){bias='strong_long';biasLabel='강한 풀롱';direction='롱';}
        else if(signalResult.signal?.type==='풀숏'){bias='strong_short';biasLabel='강한 풀숏';direction='숏';}
        else if(signalResult.longConds>signalResult.shortConds+18){bias='long';biasLabel='롱 우세';direction='롱';}
        else if(signalResult.shortConds>signalResult.longConds+18){bias='short';biasLabel='숏 우세';direction='숏';}
    }

    // 방향별 진입/종료가 결정 (가중치 가장 높은 클러스터 선택, 너무 가까운 것 제외)
    const minDistPct=0.003; // 진입은 현재가에서 0.3% 이상 떨어진 곳
    const isShort=direction==='숏'||direction==='숏(약)'||bias==='strong_short'||bias==='short';

    // 롱: 진입가=지지, 종료가=저항
    // 숏: 진입가=저항, 종료가=지지
    const entryPool=isShort
        ?resCl.filter(c=>(c.price-price)/price>=minDistPct)
        :supCl.filter(c=>(price-c.price)/price>=minDistPct);
    const exitPool=isShort
        ?supCl.filter(c=>(price-c.price)/price>=minDistPct)
        :resCl.filter(c=>(c.price-price)/price>=minDistPct);

    // ── 진입가 현실화 (ATR 연동 동적 지지/저항) ──
    // 문제: entryPool은 '가중치' 순이라, 25% 떨어진 MA200 같은 고가중 레벨이 1순위로 뽑혀
    //       현재가 0.5424에 진입가 0.4045 같은 비현실적 값이 나왔음.
    // 해결: 현재가에서 최대 atr*3 이내(현실적 눌림목 범위)의 클러스터만 인정하고,
    //       그 범위에 강한 S/R이 없으면 ATR 기반 동적 지지선(현재가 ∓ATR×1.5/×2.5)으로 폴백.
    const maxEntryDist=Math.max(atr*3,price*0.005); // 변동성 기반 최대 진입 거리(최소 0.5%)
    const entryInBand=entryPool.filter(c=>Math.abs(c.price-price)<=maxEntryDist);
    const atrE1=isShort?price+atr*1.5:price-atr*1.5;
    const atrE2=isShort?price+atr*2.5:price-atr*2.5;
    let _e1=entryInBand[0]||{price:atrE1,labels:['ATR×1.5'],w:1};
    let _e2=entryInBand[1]||{price:atrE2,labels:['ATR×2.5'],w:1};
    // 분할 진입: 가까운 쪽을 1차, 먼 쪽을 2차로 정렬
    if(Math.abs(_e2.price-price)<Math.abs(_e1.price-price)){const t=_e1;_e1=_e2;_e2=t;}
    const entry1=_e1,entry2=_e2;
    const exit1=exitPool[0]||(isShort?{price:price-atr,labels:['ATR'],w:1}:{price:price+atr,labels:['ATR'],w:1});
    const exit2=exitPool[1]||(isShort?{price:price-atr*2,labels:['ATR×2'],w:1}:{price:price+atr*2,labels:['ATR×2'],w:1});

    // 손절: 롱이면 entry2 -0.5% 또는 ATR×2.5 아래, 숏이면 entry2 +0.5% 또는 ATR×2.5 위
    const stopLoss=isShort
        ?Math.max(entry2.price*1.005,price+atr*2.5)
        :Math.min(entry2.price*0.995,price-atr*2.5);

    // R:R 계산
    const risk=Math.abs(price-stopLoss);
    const reward1=Math.abs(exit1.price-price);
    const reward2=Math.abs(exit2.price-price);
    const rr1=risk>0?(reward1/risk).toFixed(2):'-';
    const rr2=risk>0?(reward2/risk).toFixed(2):'-';

    // ─── 안전 청산가 계산 (각 진입가별) ───
    // 청산가는 손절가보다 충분히 멀어야 함 (손절선 닿기 전에 청산되면 안 됨)
    // 권장: 청산가 = 손절가에서 5% 추가 버퍼
    // 안전 청산가 계산 함수
    function calcSafeLiq(entry){
        if(isShort){
            return entry*1.18; // 숏: 진입가 +18% 위에서 청산 (5x 레버 안전권)
        }else{
            return entry*0.82; // 롱: 진입가 -18% 아래에서 청산
        }
    }
    // 권장 최대 레버리지 (손절가까지 거리 + 2배 버퍼)
    function calcMaxLev(entry){
        const distPct=Math.abs(entry-stopLoss)/entry;
        // 청산가가 손절가의 2배 거리에 오도록 → 레버리지 = 1/(2*distPct + 유지마진0.005)
        const maxLev=Math.floor(1/(distPct*2+0.005));
        return Math.min(Math.max(maxLev,2),10); // 2~10배 범위
    }
    const entry1SafeLiq=calcSafeLiq(entry1.price);
    const entry2SafeLiq=calcSafeLiq(entry2.price);
    const entry1MaxLev=calcMaxLev(entry1.price);
    const entry2MaxLev=calcMaxLev(entry2.price);

    return{
        price,bias,biasLabel,direction,isShort,
        entry1,entry2,exit1,exit2,stopLoss,
        entry1SafeLiq,entry2SafeLiq,
        entry1MaxLev,entry2MaxLev,
        dangerLong:liqDanger?.maxLongCluster?.price,
        dangerShort:liqDanger?.maxShortCluster?.price,
        rr1,rr2,atr,
        indicatorCount:supports.length+resistances.length,
    };
}

function renderTradeRecommendation(rec){
    const el=document.getElementById('tradeRecPanel');
    if(!el)return;
    if(!rec){el.style.display='none';return;}
    el.style.display='';
    const fmt=v=>v?fp(v):'-';
    const pct=v=>v?((v-rec.price)/rec.price*100).toFixed(2):'-';
    const biasColor={
        strong_long:'#FFD700',long:'rgba(255,215,0,0.7)',
        strong_short:'#FF69B4',short:'rgba(255,105,180,0.7)',
        neutral:'#888',
    }[rec.bias];
    const entryColor=rec.isShort?'#FF69B4':'#FFD700';
    const exitColor=rec.isShort?'#FFD700':'#FF69B4';
    const dirBadge=rec.direction==='롱'||rec.direction==='롱(약)'
        ?`<span style="display:inline-block;padding:2px 10px;border-radius:50px;background:#FFD700;color:#000;font-size:12px;font-weight:800;margin-right:6px;">롱 LONG</span>`
        :rec.direction==='숏'||rec.direction==='숏(약)'
        ?`<span style="display:inline-block;padding:2px 10px;border-radius:50px;background:#FF69B4;color:#fff;font-size:12px;font-weight:800;margin-right:6px;">숏 SHORT</span>`
        :`<span style="display:inline-block;padding:2px 10px;border-radius:50px;background:#888;color:#fff;font-size:12px;font-weight:800;margin-right:6px;">관망</span>`;
    el.innerHTML=`
        <div style="display:grid;grid-template-columns:auto 1fr 1fr 1fr;gap:14px;align-items:center;padding:10px 16px;">
            <div style="border-right:1px solid var(--border);padding-right:14px;">
                <div style="font-size:10px;color:var(--text-secondary);">시그널 방향</div>
                <div style="margin-top:4px;">${dirBadge}</div>
                <div style="font-size:13px;font-weight:700;color:${biasColor};margin-top:4px;">${rec.biasLabel}</div>
                <div style="font-size:10px;color:var(--text-secondary);margin-top:2px;">현재 ${fmt(rec.price)} · ${rec.indicatorCount}개 지표</div>
            </div>
            <div>
                <div style="font-size:11px;color:${entryColor};font-weight:700;margin-bottom:4px;">진입가 (분할) · 안전 청산가 / 권장 레버리지</div>
                <div style="font-size:13px;color:var(--text-primary);font-weight:600;">${fmt(rec.entry1.price)} <span style="color:var(--text-secondary);font-size:10px;">(${pct(rec.entry1.price)}%) [w:${rec.entry1.w}]</span></div>
                <div style="font-size:12px;color:#ff6b6b;margin-top:2px;font-weight:600;">▸ 안전 청산가 <b style="font-size:14px;">${fmt(rec.entry1SafeLiq)}</b> · 권장 <b style="font-size:14px;">≤${rec.entry1MaxLev}x</b> <span style="color:var(--text-secondary);font-weight:400;font-size:10px;">· ${rec.entry1.labels.slice(0,2).join('+')}</span></div>
                <div style="font-size:12px;color:var(--text-secondary);margin-top:6px;">${fmt(rec.entry2.price)} <span style="font-size:10px;">(${pct(rec.entry2.price)}%) [w:${rec.entry2.w}]</span></div>
                <div style="font-size:12px;color:#ff6b6b;margin-top:2px;font-weight:600;">▸ 안전 청산가 <b style="font-size:14px;">${fmt(rec.entry2SafeLiq)}</b> · 권장 <b style="font-size:14px;">≤${rec.entry2MaxLev}x</b> <span style="color:var(--text-secondary);font-weight:400;font-size:10px;">· ${rec.entry2.labels.slice(0,2).join('+')}</span></div>
            </div>
            <div>
                <div style="font-size:11px;color:${exitColor};font-weight:700;margin-bottom:4px;">종료가 (분할)</div>
                <div style="font-size:13px;color:var(--text-primary);font-weight:600;">${fmt(rec.exit1.price)} <span style="color:var(--text-secondary);font-size:10px;">(${pct(rec.exit1.price)}%) [w:${rec.exit1.w}] ${rec.exit1.labels.slice(0,2).join('+')}</span></div>
                <div style="font-size:12px;color:var(--text-secondary);margin-top:2px;">${fmt(rec.exit2.price)} <span style="font-size:10px;">(${pct(rec.exit2.price)}%) [w:${rec.exit2.w}] ${rec.exit2.labels.slice(0,2).join('+')}</span></div>
            </div>
            <div>
                <div style="font-size:11px;color:#ff4757;font-weight:700;margin-bottom:4px;">손절 / 위험</div>
                <div style="font-size:13px;color:#ff4757;font-weight:600;">${fmt(rec.stopLoss)} <span style="color:var(--text-secondary);font-size:10px;">(${pct(rec.stopLoss)}%)</span></div>
                <div style="font-size:10px;color:var(--text-secondary);margin-top:2px;">R:R 1차 <b style="color:${parseFloat(rec.rr1)>=2?'#00d26a':parseFloat(rec.rr1)>=1?'#FFD700':'#ff4757'}">${rec.rr1}</b> / 2차 <b style="color:${parseFloat(rec.rr2)>=2?'#00d26a':parseFloat(rec.rr2)>=1?'#FFD700':'#ff4757'}">${rec.rr2}</b></div>
                ${rec.dangerLong?`<div style="font-size:10px;color:#ff4757;margin-top:2px;">롱청산자석 ${fmt(rec.dangerLong)}</div>`:''}
                ${rec.dangerShort?`<div style="font-size:10px;color:#ff4757;margin-top:2px;">숏청산자석 ${fmt(rec.dangerShort)}</div>`:''}
            </div>
        </div>
    `;
}

function renderPredictionPanel(d,signalResult){
    // 매수/매도 추천도 함께 갱신
    try{
        const rec=calculateTradeRecommendation(d,signalResult);
        renderTradeRecommendation(rec);
    }catch(e){console.warn('trade rec err',e);}
    const el=document.getElementById('predictionPanel');
    if(!el)return;
    if(!d||d.length<60){el.innerHTML='<div style="color:var(--text-secondary);font-size:11px;">데이터 부족</div>';return;}

    const pr1=predictPriceRange(d,1);
    const pr6=predictPriceRange(d,6);
    const pr24=predictPriceRange(d,24);
    const cyc=detectMarketCycle(d);
    const tp=analyzeTimePatterns(d);
    const next=signalResult?predictNextSignal(d,{
        longConds:signalResult.longConds,shortConds:signalResult.shortConds,
        totalConds:signalResult.totalConds||83,
    }):null;

    const fmtPx=v=>v?(v>=1?v.toFixed(2):v.toFixed(6)):'-';
    const probColor=p=>p>=65?G:p<=35?R:YL;

    let html='';

    // 1. 가격 범위 예측 (1봉 / 6봉 / 24봉)
    html+='<div style="margin-bottom:10px;"><div style="color:var(--text-secondary);font-size:10px;margin-bottom:4px;">향후 가격 범위 예측 (현재 시간프레임 기준)</div>';
    html+='<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">';
    [['1봉',pr1],['6봉',pr6],['24봉',pr24]].forEach(([lbl,pr])=>{
        if(!pr)return;
        const c=probColor(pr.upProb);
        html+=`<div style="background:rgba(255,255,255,0.03);padding:6px 8px;border-radius:4px;border-left:3px solid ${c}">
            <div style="font-size:10px;color:var(--text-secondary);">${lbl} 후</div>
            <div style="font-size:11px;color:var(--text-primary);font-weight:600;">${fmtPx(pr.lower)} ~ ${fmtPx(pr.upper)}</div>
            <div style="font-size:10px;color:${c};margin-top:2px;">↑${pr.upProb}% / ↓${pr.downProb}% (예상 ${pr.expectedReturn>=0?'+':''}${pr.expectedReturn.toFixed(2)}%)</div>
        </div>`;
    });
    html+='</div></div>';

    // 2. 다음 풀롱/풀숏 트리거 카운트다운
    if(next){
        const trigColor=next.type==='풀롱'?'#FFD700':'#FF69B4';
        const eta=next.barsToTrigger!==null?(next.barsToTrigger===0?'트리거 임박':`약 ${next.barsToTrigger}봉 후`):next.estimate;
        html+=`<div style="margin-bottom:10px;background:rgba(${next.type==='풀롱'?'255,215,0':'255,105,180'},0.1);padding:8px 10px;border-radius:5px;border-left:4px solid ${trigColor}">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <span style="color:${trigColor};font-weight:700;font-size:12px;">다음 ${next.type} 트리거</span>
                <span style="color:var(--text-primary);font-weight:700;font-size:13px;">${eta}</span>
            </div>
            <div style="font-size:10px;color:var(--text-secondary);margin-top:3px;">현재 ${next.score} / 임계값 ${next.threshold} (남은 ${Math.max(0,next.remaining)}점${next.deltaPerBar?`, 봉당 +${next.deltaPerBar}점`:''})</div>
        </div>`;
    }

    // 3. RSI 사이클
    if(cyc&&cyc.nextEvent){
        const ev=cyc.nextEvent;
        const evColor=ev.type==='trough'?G:R;
        const evIcon=ev.type==='trough'?'▲':'▼';
        html+=`<div style="margin-bottom:10px;background:rgba(${ev.type==='trough'?'0,210,106':'255,71,87'},0.1);padding:8px 10px;border-radius:5px;border-left:4px solid ${evColor}">
            <div style="display:flex;justify-content:space-between;">
                <span style="color:${evColor};font-weight:700;font-size:12px;">${evIcon} ${ev.desc}</span>
                <span style="color:var(--text-primary);font-weight:700;font-size:13px;">${ev.barsRemain}봉 후</span>
            </div>
            <div style="font-size:10px;color:var(--text-secondary);margin-top:3px;">평균 사이클: 고점 ${cyc.avgPeakCycle||'-'}봉 / 저점 ${cyc.avgTroughCycle||'-'}봉</div>
        </div>`;
    }

    // 4. 시간대 통계 (현재 시간 + 다음 6시간)
    if(tp){
        const nowHr=new Date().getHours();
        html+='<div><div style="color:var(--text-secondary);font-size:10px;margin-bottom:4px;">시간대별 상승확률 (현재→6시간)</div>';
        html+='<div style="display:grid;grid-template-columns:repeat(7,1fr);gap:3px;">';
        for(let i=0;i<7;i++){
            const hr=(nowHr+i)%24;
            const stat=tp.hours[hr];
            if(!stat||stat.n<3){
                html+=`<div style="text-align:center;padding:5px 2px;font-size:9px;background:rgba(255,255,255,0.02);border-radius:3px;color:var(--text-secondary);">
                    <div style="font-weight:700;">${hr}h</div><div>-</div>
                </div>`;
                continue;
            }
            const c=probColor(stat.upRate);
            const isNow=i===0;
            html+=`<div style="text-align:center;padding:5px 2px;font-size:9px;background:${isNow?'rgba(240,185,11,0.2)':'rgba(255,255,255,0.03)'};border-radius:3px;border:${isNow?'1px solid '+YL:'none'};">
                <div style="font-weight:700;color:var(--text-primary);">${hr}h</div>
                <div style="color:${c};font-weight:600;">${stat.upRate.toFixed(0)}%</div>
                <div style="color:var(--text-secondary);font-size:8px;">${stat.avgChange>=0?'+':''}${stat.avgChange.toFixed(2)}</div>
            </div>`;
        }
        html+='</div></div>';
    }

    el.innerHTML=html;
}

async function updateEtherscan(){
    try{
        const [es,flow]=await Promise.all([
            fetchJSON('/api/etherscan').catch(()=>null),
            fetchJSON('/api/eth-flow').catch(()=>null),
        ]);

        // ── 가스/가격/블록 ticker ──
        if(es&&!es.error){
            lastEthGas=es.gas||{};
            lastEthPrice=es.eth_price_usd||0;
            const gEl=document.getElementById('tickGas');
            const pEl=document.getElementById('tickEthPrice');
            const bEl=document.getElementById('tickBlock');
            if(gEl&&lastEthGas.propose){
                const g=lastEthGas.propose;
                const c=g<20?G:g<50?YL:g<100?'#ff9f43':R;
                gEl.textContent=`${g.toFixed(0)} Gwei`;
                gEl.style.color=c;
                gEl.title=`Safe: ${lastEthGas.safe} | Avg: ${lastEthGas.propose} | Fast: ${lastEthGas.fast}`;
            }
            if(pEl&&lastEthPrice)pEl.textContent=`$${lastEthPrice.toFixed(2)}`;
            if(bEl&&es.block_number)bEl.textContent=`#${es.block_number.toLocaleString()}`;

            // 가스 카드 내용
            const gasEl=document.getElementById('ethGasInfo');
            if(gasEl&&lastEthGas.propose){
                const totalEth=(es.supply?.total||0);
                const mcap=(es.supply?.market_cap||0);
                const ath=(es.supply?.ath_usd||0);
                const atl=(es.supply?.atl_usd||0);
                const ch24=(es.supply?.change_24h||0);
                const ch24Color=ch24>=0?G:R;
                const athPct=ath>0&&lastEthPrice>0?((lastEthPrice-ath)/ath*100):0;
                gasEl.innerHTML=`
                    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:8px;">
                        <div style="background:rgba(0,210,106,0.1);padding:6px;border-radius:4px;text-align:center;border:1px solid ${G}">
                            <div style="color:var(--text-secondary);font-size:10px;">저속</div>
                            <div style="color:${G};font-size:18px;font-weight:700;">${lastEthGas.safe.toFixed(0)}</div>
                            <div style="color:var(--text-secondary);font-size:9px;">Gwei</div>
                        </div>
                        <div style="background:rgba(240,185,11,0.1);padding:6px;border-radius:4px;text-align:center;border:1px solid ${YL}">
                            <div style="color:var(--text-secondary);font-size:10px;">평균</div>
                            <div style="color:${YL};font-size:18px;font-weight:700;">${lastEthGas.propose.toFixed(0)}</div>
                            <div style="color:var(--text-secondary);font-size:9px;">Gwei</div>
                        </div>
                        <div style="background:rgba(255,71,87,0.1);padding:6px;border-radius:4px;text-align:center;border:1px solid ${R}">
                            <div style="color:var(--text-secondary);font-size:10px;">빠름</div>
                            <div style="color:${R};font-size:18px;font-weight:700;">${lastEthGas.fast.toFixed(0)}</div>
                            <div style="color:var(--text-secondary);font-size:9px;">Gwei</div>
                        </div>
                    </div>
                    <div style="font-size:11px;line-height:1.7;color:var(--text-secondary);">
                        ${ch24!==0?`<div><b style="color:var(--text-primary);">24시간 변동:</b> <span style="color:${ch24Color};font-weight:700;">${ch24>=0?'+':''}${ch24.toFixed(2)}%</span></div>`:''}
                        ${mcap>0?`<div><b style="color:var(--text-primary);">마켓캡:</b> $${(mcap/1e9).toFixed(2)}B</div>`:''}
                        ${totalEth>0?`<div><b style="color:var(--text-primary);">유통 공급량:</b> ${(totalEth/1e6).toFixed(2)}M ETH</div>`:''}
                        ${ath>0?`<div><b style="color:var(--text-primary);">ATH:</b> $${ath.toLocaleString()} <span style="color:${athPct<0?R:G};">(${athPct.toFixed(1)}%)</span></div>`:''}
                        ${atl>0?`<div><b style="color:var(--text-primary);">ATL:</b> $${atl.toFixed(2)}</div>`:''}
                        ${es.eth_btc?`<div><b style="color:var(--text-primary);">ETH/BTC:</b> ${es.eth_btc.toFixed(6)}</div>`:''}
                    </div>
                `;
            }
        }

        // ── 온체인 물량 흐름 ──
        if(flow&&!flow.error&&flow.flow){
            lastEthFlow=flow.flow;
            const netFlow=flow.flow.net_flow_eth||0;
            const netEl=document.getElementById('tickNetFlow');
            if(netEl){
                const netColor=netFlow>500?G:netFlow<-500?R:YL;
                const netSign=netFlow>=0?'+':'';
                netEl.textContent=`${netSign}${netFlow.toFixed(0)} ETH`;
                netEl.style.color=netColor;
                netEl.title=`입금: ${flow.flow.cex_inflow_eth} | 출금: ${flow.flow.cex_outflow_eth}`;
            }

            // 흐름 요약
            const sumEl=document.getElementById('ethFlowSummary');
            if(sumEl){
                const inflow=flow.flow.cex_inflow_eth||0;
                const outflow=flow.flow.cex_outflow_eth||0;
                const biasText=netFlow>200?'매도 압력 (CEX 순입금)':netFlow<-200?'매수 의사 (CEX 순출금)':'중립';
                const biasColor=netFlow>200?R:netFlow<-200?G:YL;
                sumEl.innerHTML=`
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">
                        <div style="background:rgba(255,71,87,0.1);padding:6px 8px;border-radius:4px;border-left:3px solid ${R}">
                            <div style="color:var(--text-secondary);font-size:10px;">CEX 입금</div>
                            <div style="color:${R};font-size:15px;font-weight:700;">${inflow.toFixed(2)} ETH</div>
                        </div>
                        <div style="background:rgba(0,210,106,0.1);padding:6px 8px;border-radius:4px;border-left:3px solid ${G}">
                            <div style="color:var(--text-secondary);font-size:10px;">CEX 출금</div>
                            <div style="color:${G};font-size:15px;font-weight:700;">${outflow.toFixed(2)} ETH</div>
                        </div>
                    </div>
                    <div style="text-align:center;padding:5px;background:rgba(0,0,0,0.2);border-radius:4px;color:${biasColor};font-weight:700;font-size:12px;">
                        순흐름: ${netFlow>=0?'+':''}${netFlow.toFixed(2)} ETH · ${biasText}
                    </div>
                    <div style="font-size:10px;color:var(--text-secondary);margin-top:4px;text-align:center;">블록 #${flow.block_number?.toLocaleString()} · ${flow.shown_txs}/${flow.total_txs} 트랜잭션</div>
                `;
            }

            // 트랜잭션 목록
            const txEl=document.getElementById('ethFlowTxs');
            if(txEl){
                const txs=(flow.txs||[]).filter(t=>t.value_eth>=10); // 10 ETH 이상
                if(!txs.length){
                    txEl.innerHTML='<div style="color:var(--text-secondary);font-size:11px;text-align:center;padding:20px;">10 ETH 이상 거래 없음</div>';
                }else{
                    txEl.innerHTML=txs.map(t=>{
                        const typeColor=t.is_cex_inflow?R:t.is_cex_outflow?G:'var(--text-secondary)';
                        const typeIcon=t.is_cex_inflow?'IN':t.is_cex_outflow?'OUT':'·';
                        const typeLabel=t.is_cex_inflow?'입금':t.is_cex_outflow?'출금':'이동';
                        return `
                            <div style="display:grid;grid-template-columns:1fr auto;gap:4px;padding:4px 6px;border-bottom:1px solid rgba(255,255,255,0.05);font-size:10px;">
                                <div>
                                    <div style="color:${typeColor};font-weight:700;">${typeIcon} ${typeLabel} · ${t.value_eth.toFixed(2)} ETH</div>
                                    <div style="color:var(--text-secondary);font-size:9px;">${t.from_label} → ${t.to_label}</div>
                                </div>
                                <a href="https://etherscan.io/tx/${t.hash}" target="_blank" style="color:var(--blue);font-size:9px;align-self:center;text-decoration:none;">[link]</a>
                            </div>
                        `;
                    }).join('');
                }
            }
        }
    }catch(e){console.warn('etherscan update failed',e);}
}

/* ═══════════════════════════════════
   풀롱/풀숏 초정밀 시그널 (20개 조건 검증)
   미래 캔들 영역에 시그널 표시
   ═══════════════════════════════════ */
let lastFearGreedValue=50; // 공포탐욕지수 캐시
let lastLongShortRatio={buy:0.5,sell:0.5}; // 롱숏비율 캐시
let lastOIChange=0; // 미결제약정 변동률 캐시
let lastConsensusScore=50; // 전문가 컨센서스 점수 캐시
let lastKimchiPremium=0; // 김치프리미엄 % 캐시

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

// ─── 강화된 StochRSI 분석: 5가지 패턴 (과매도크로스/과매수크로스/히든다이버/더블바텀/더블탑) ───
function analyzeStochRSI(d){
    const rsiData=calcRSI(d,14);
    if(!rsiData||rsiData.length<35)return null;
    const rsiVals=rsiData.map(r=>r.value);
    const stochPeriod=14,kSmooth=3,dSmooth=3;
    const stochK=[];
    for(let i=stochPeriod-1;i<rsiVals.length;i++){
        const slice=rsiVals.slice(i-stochPeriod+1,i+1);
        const min=Math.min(...slice),max=Math.max(...slice);
        stochK.push(max===min?50:(rsiVals[i]-min)/(max-min)*100);
    }
    const sK=[];
    for(let i=kSmooth-1;i<stochK.length;i++){
        let s=0;for(let j=i-kSmooth+1;j<=i;j++)s+=stochK[j];
        sK.push(s/kSmooth);
    }
    const sD=[];
    for(let i=dSmooth-1;i<sK.length;i++){
        let s=0;for(let j=i-dSmooth+1;j<=i;j++)s+=sK[j];
        sD.push(s/dSmooth);
    }
    if(sK.length<10||sD.length<10)return null;

    const k=sK[sK.length-1],kP=sK[sK.length-2];
    const dV=sD[sD.length-1],dP=sD[sD.length-2];

    // 1. 골든/데드 크로스
    const goldenCross=kP<=dP&&k>dV;
    const deadCross=kP>=dP&&k<dV;
    // 2. 과매도/과매수 크로스 (강한 신호)
    const oversoldGolden=goldenCross&&k<25;
    const overboughtDead=deadCross&&k>75;

    // 3. Hidden Divergence (가격 vs StochRSI)
    let hiddenBullDiv=false,hiddenBearDiv=false;
    if(d.length>=20&&sK.length>=20){
        const recentLow=Math.min(...d.slice(-5).map(c=>c.low));
        const prevLow=Math.min(...d.slice(-15,-5).map(c=>c.low));
        const recentStochLow=Math.min(...sK.slice(-5));
        const prevStochLow=Math.min(...sK.slice(-15,-5));
        // Bullish hidden div: 가격 higher low + Stoch lower low (지속 상승)
        if(recentLow>prevLow*1.001&&recentStochLow<prevStochLow*0.95&&k<35)hiddenBullDiv=true;
        const recentHigh=Math.max(...d.slice(-5).map(c=>c.high));
        const prevHigh=Math.max(...d.slice(-15,-5).map(c=>c.high));
        const recentStochHigh=Math.max(...sK.slice(-5));
        const prevStochHigh=Math.max(...sK.slice(-15,-5));
        // Bearish hidden div: 가격 lower high + Stoch higher high (지속 하락)
        if(recentHigh<prevHigh*0.999&&recentStochHigh>prevStochHigh*1.05&&k>65)hiddenBearDiv=true;
    }

    // 4. 더블 바텀/탑 (StochRSI 자체)
    let doubleBottom=false,doubleTop=false;
    if(sK.length>=20){
        const r20=sK.slice(-20);
        const lows=[];
        for(let i=2;i<r20.length-2;i++){
            if(r20[i]<r20[i-1]&&r20[i]<r20[i-2]&&r20[i]<r20[i+1]&&r20[i]<r20[i+2]&&r20[i]<25)lows.push({i,v:r20[i]});
        }
        if(lows.length>=2){
            const last2=lows.slice(-2);
            // 두 저점이 비슷한 수준 + 간격 4봉 이상
            if(Math.abs(last2[0].v-last2[1].v)<10&&last2[1].i-last2[0].i>=4&&k>last2[1].v+5)doubleBottom=true;
        }
        const highs=[];
        for(let i=2;i<r20.length-2;i++){
            if(r20[i]>r20[i-1]&&r20[i]>r20[i-2]&&r20[i]>r20[i+1]&&r20[i]>r20[i+2]&&r20[i]>75)highs.push({i,v:r20[i]});
        }
        if(highs.length>=2){
            const last2=highs.slice(-2);
            if(Math.abs(last2[0].v-last2[1].v)<10&&last2[1].i-last2[0].i>=4&&k<last2[1].v-5)doubleTop=true;
        }
    }

    return{
        k,d:dV,kPrev:kP,dPrev:dP,
        oversold:k<20,overbought:k>80,
        goldenCross,deadCross,
        oversoldGolden,overboughtDead,
        hiddenBullDiv,hiddenBearDiv,
        doubleBottom,doubleTop,
    };
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

// ─── forward-test 로깅 (풀롱/풀숏 트리거 시 1종목당 중복방지) ───
let _ftLastLog={}; // {symbol: {type, ts}}
function logForwardTest(result){
    if(!result||!result.signal)return; // 풀롱/풀숏 트리거만 기록
    const sym=currentSymbol;
    const type=result.signal.type;
    const now=Date.now();
    const last=_ftLastLog[sym];
    // 같은 종목+방향은 30분 내 중복 기록 안 함
    if(last&&last.type===type&&now-last.ts<1800000)return;
    _ftLastLog[sym]={type,ts:now};
    const price=lastKlineData?.[lastKlineData.length-1]?.close||0;
    const symClass=sym==='BTCUSDT'||sym==='ETHUSDT'?'major':isStock(sym)?'stock':'alt';
    const direction=type==='풀롱'?'long':type==='풀숏'?'short':'';
    fetch('/api/forwardtest/log',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
            symbol:sym,symClass,type,price,
            // ↓ 신호→결과 페어링용 (N시간 뒤 실제가와 대조)
            entry_price:price,direction,horizon_hours:4,
            interval:currentInterval,
            longConds:result.longConds,shortConds:result.shortConds,
            ts:now,
        }),
    }).catch(()=>{});
}

// ── forward-test 결과 페어링 (TP/SL 배리어 + 비용 차감) ──
// 서버는 CloudFront로 Bybit를 못 받으므로, 브라우저가 진입~horizon 구간 kline 경로를
// 걸어 TP(+2%)/SL(-1%) 중 무엇이 먼저 닿았는지 판정하고 왕복수수료(0.11%)를 차감해 보낸다.
// 실제 매매 전략과 측정 전략을 일치시킨다(종가 한 점만 보던 갭 해소).
function recordFtPrice(){}  // (구버전 호환용 no-op)
const FT_TP_PCT=2.0, FT_SL_PCT=1.0, FT_RT_FEE_PCT=0.11; // 익절%/손절%/왕복수수료%
async function resolveForwardTest(){
    try{
        const r=await fetch('/api/forwardtest').then(x=>x.json()).catch(()=>null);
        if(!r||!Array.isArray(r.log))return;
        const nowSec=Date.now()/1000;
        const pending=r.log.filter(e=>!e.resolved&&e.entry_price>0&&e.symbol&&
            (e.direction==='long'||e.direction==='short')&&
            (nowSec-(e.ts||nowSec))>=(e.horizon_hours||4)*3600);
        if(!pending.length)return;
        const resolutions=[];
        for(const e of pending.slice(0,12)){ // 한 사이클 최대 12건 (Bybit 부하 제한)
            try{
                const entry=+e.entry_price, dir=e.direction;
                const horizonSec=(e.horizon_hours||4)*3600;
                const endT=e.ts+horizonSec;
                // 5분봉 ~500개(≈41h)로 진입~horizon 구간 커버
                const kl=await bybitKline(e.symbol,'5',500).catch(()=>[]);
                const path=kl.filter(c=>c.time>=e.ts&&c.time<=endT);
                if(!path.length)continue;
                const tpP=dir==='long'?entry*(1+FT_TP_PCT/100):entry*(1-FT_TP_PCT/100);
                const slP=dir==='long'?entry*(1-FT_SL_PCT/100):entry*(1+FT_SL_PCT/100);
                let outcome='timeout', exitP=path[path.length-1].close;
                for(const c of path){
                    // 한 캔들 안에 둘 다 닿으면 보수적으로 SL 우선(최악 가정)
                    const slHit=dir==='long'?c.low<=slP:c.high>=slP;
                    const tpHit=dir==='long'?c.high>=tpP:c.low<=tpP;
                    if(slHit){outcome='sl';exitP=slP;break;}
                    if(tpHit){outcome='tp';exitP=tpP;break;}
                }
                const changePct=(exitP-entry)/entry*100;
                let realized=(dir==='long'?changePct:-changePct)-FT_RT_FEE_PCT; // 비용 차감
                resolutions.push({ts:e.ts,exit_price:+exitP.toFixed(8),
                    change_pct:+changePct.toFixed(4),realized_pct:+realized.toFixed(4),
                    correct:realized>0,outcome});
            }catch(_){}
        }
        if(resolutions.length){
            await fetch('/api/forwardtest/resolve',{
                method:'POST',headers:{'Content-Type':'application/json'},
                body:JSON.stringify({resolutions}),
            }).catch(()=>{});
        }
    }catch(e){}
}
// 10분마다 페어링 시도
setInterval(resolveForwardTest,600000);

function generateFullSignal(d){
    if(d.length<110)return null;
    const last=d[d.length-1],prev=d[d.length-2],prev2=d[d.length-3];
    const price=last.close;

    // 지표 계산
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

    let lS=0,sS=0; // longScore, shortScore (가중합)
    const lR=[],sR=[];
    // 주식은 크립토 전용 지표(OI/청산/펀딩/김프/가스/거래소) 부재 → 가격 TA만으로 평가
    const _isStockSym=isStock(currentSymbol);
    // 다중공선성 제거(추세/매크로/볼륨/L-S/OI 합의 통합) 후 만점 재산정 — 약 25점 감소
    const TOTAL_MAX=_isStockSym?75:100; // 주식: 75 / 크립토: 100 (개선 전 95/125)

    // ── 모멘텀 오실레이터 합의 (다중공선성 방지) ──
    // RSI·W%R·CCI는 거의 같은 과매수/과매도를 측정 → 개별 카운팅 시 같은 정보 3번 중복.
    // 다수결 합의로 1번만 가점: 3개 모두 일치 = 강함(+3), 2개 = 약함(+1).
    // (StochRSI는 별도 크로스/패턴 조건에서 평가하므로 합의에서 제외 — 이중카운팅 방지)
    {
        let momBull=0,momBear=0;
        const mbList=[],msList=[]; // 동의한 지표 이름
        if(rsi<35){momBull++;mbList.push(`RSI${rsi.toFixed(0)}`);}
        else if(rsi>65){momBear++;msList.push(`RSI${rsi.toFixed(0)}`);}
        const _wr=calcWilliamsR(d,14);
        if(_wr!==null){
            if(_wr<-80){momBull++;mbList.push(`W%R${_wr.toFixed(0)}`);}
            else if(_wr>-20){momBear++;msList.push(`W%R${_wr.toFixed(0)}`);}
        }
        const _cci=calcCCI(d,20);
        if(_cci!==null){
            if(_cci<-100){momBull++;mbList.push(`CCI${_cci.toFixed(0)}`);}
            else if(_cci>100){momBear++;msList.push(`CCI${_cci.toFixed(0)}`);}
        }
        if(momBull>=3){lS+=3;lR.push(`모멘텀합의과매도${momBull}/3 [${mbList.join('·')}]`);}
        else if(momBull>=2){lS+=1;lR.push(`모멘텀약과매도${momBull}/3 [${mbList.join('·')}]`);}
        if(momBear>=3){sS+=3;sR.push(`모멘텀합의과매수${momBear}/3 [${msList.join('·')}]`);}
        else if(momBear>=2){sS+=1;sR.push(`모멘텀약과매수${momBear}/3 [${msList.join('·')}]`);}
    }
    // ── 1점 조건 ──
    // 2) 양봉/음봉
    if(last.close>last.open){lS+=1;lR.push('양봉');}
    if(last.close<last.open){sS+=1;sR.push('음봉');}
    // 3) 이전 봉 반전
    if(prev.close<prev.open&&last.close>last.open){lS+=1;lR.push('반전양봉');}
    if(prev.close>prev.open&&last.close<last.open){sS+=1;sR.push('반전음봉');}
    // 6) MA7 → 추세 합의로 통합 (제거)
    // 7) 해머/슈팅스타
    if(lowerWick>body*1.5&&last.close>last.open){lS+=1;lR.push('해머');}
    if(upperWick>body*1.5&&last.close<last.open){sS+=1;sR.push('슈팅스타');}
    // ── 볼륨 합의 (거래량 방향 지표 4개 → 합의로 통합) ──
    // 거래량↑+양봉 / OBV / VWAP / 거래량폭발은 모두 '거래량이 가격을 지지하는가'를 측정
    // → 같은 정보 중복 카운트 방지 위해 합의 처리.
    const obvSeries=calcOBVSeries(d);
    const vwap=calcVWAP(d.slice(-50));
    {
        let volBull=0,volBear=0;
        const vbList=[],vsList=[];
        // (1) 거래량↑ + 캔들 방향
        if(last.volume>prev.volume*1.2){
            if(last.close>last.open){volBull++;vbList.push('거래량↑양봉');}
            else if(last.close<last.open){volBear++;vsList.push('거래량↑음봉');}
        }
        // (2) OBV + 캔들 방향
        if(obvSeries.length>=2){
            const obvUp=obvSeries[obvSeries.length-1]>obvSeries[obvSeries.length-2];
            if(obvUp&&last.close>last.open){volBull++;vbList.push('OBV↑');}
            else if(!obvUp&&last.close<last.open){volBear++;vsList.push('OBV↓');}
        }
        // (3) VWAP 위/아래
        if(price>vwap*1.002){volBull++;vbList.push('VWAP↑');}
        else if(price<vwap*0.998){volBear++;vsList.push('VWAP↓');}
        // (4) 거래량 폭발 + 방향
        if(d.length>=3){
            const av2=(d[d.length-2].volume+d[d.length-3].volume)/2;
            if(av2>0&&last.volume>av2*2){
                if(last.close>last.open){volBull++;vbList.push('폭발↑');}
                else if(last.close<last.open){volBear++;vsList.push('폭발↓');}
            }
        }
        if(volBull>=3){lS+=2;lR.push(`볼륨합의↑${volBull}/4 [${vbList.join('·')}]`);}
        else if(volBull>=2){lS+=1;lR.push(`볼륨약↑${volBull}/4 [${vbList.join('·')}]`);}
        if(volBear>=3){sS+=2;sR.push(`볼륨합의↓${volBear}/4 [${vsList.join('·')}]`);}
        else if(volBear>=2){sS+=1;sR.push(`볼륨약↓${volBear}/4 [${vsList.join('·')}]`);}
    }
    // 21~22) Williams %R, CCI → 위 '모멘텀 합의'로 통합 (중복 제거)
    // 29~32) 매크로 (DXY, US10Y, S&P, Gold)
    // ── 매크로 합의 (DXY/금리/S&P/골드는 서로 상관관계 큼 → 개별 X, 합의로 통합) ──
    {
        let macroBull=0,macroBear=0;
        const mbList=[],msList=[];
        if(macroCache['DX-Y.NYB']){
            const v=macroCache['DX-Y.NYB'].change;
            if(v<-0.1){macroBull++;mbList.push(`DXY${v.toFixed(2)}%`);}
            else if(v>0.1){macroBear++;msList.push(`DXY+${v.toFixed(2)}%`);}
        }
        if(macroCache['^TNX']){
            const v=macroCache['^TNX'].change;
            if(v<-0.5){macroBull++;mbList.push(`금리${v.toFixed(2)}%`);}
            else if(v>0.5){macroBear++;msList.push(`금리+${v.toFixed(2)}%`);}
        }
        if(macroCache['^GSPC']){
            const v=macroCache['^GSPC'].change;
            if(v>0.3){macroBull++;mbList.push(`S&P+${v.toFixed(2)}%`);}
            else if(v<-0.3){macroBear++;msList.push(`S&P${v.toFixed(2)}%`);}
        }
        if(macroCache['GC=F']){
            const v=macroCache['GC=F'].change;
            if(v>0.5){macroBull++;mbList.push(`골드+${v.toFixed(2)}%`);}
            else if(v<-0.5){macroBear++;msList.push(`골드${v.toFixed(2)}%`);}
        }
        if(macroBull>=3){lS+=2;lR.push(`매크로합의↑${macroBull}/4 [${mbList.join('·')}]`);}
        else if(macroBull>=2){lS+=1;lR.push(`매크로약↑${macroBull}/4 [${mbList.join('·')}]`);}
        if(macroBear>=3){sS+=2;sR.push(`매크로합의↓${macroBear}/4 [${msList.join('·')}]`);}
        else if(macroBear>=2){sS+=1;sR.push(`매크로약↓${macroBear}/4 [${msList.join('·')}]`);}
    }
    // 33) 센티먼트
    if(lastSentimentData){if(lastSentimentData.up>65){lS+=1;lR.push('센티먼트강세');}if(lastSentimentData.up<35){sS+=1;sR.push('센티먼트약세');}}
    // 34) 전문가 컨센서스
    if(lastConsensusScore>65){lS+=1;lR.push('컨센서스강세');}
    if(lastConsensusScore<35){sS+=1;sR.push('컨센서스약세');}

    // ── 2점 조건 (16개, 총 32점) ──
    // 5) MACD
    if(macdHist>macdHistPrev){lS+=2;lR.push('MACD↑');}
    if(macdHist<macdHistPrev){sS+=2;sR.push('MACD↓');}
    // 8) MA20 지지/저항
    if(last.low<m20&&last.close>m20){lS+=2;lR.push('MA20지지');}
    if(last.high>m20&&last.close<m20){sS+=2;sR.push('MA20저항');}
    // 10) 추세정렬 MA20>MA100
    // 추세정렬(m20>m100) → 추세 합의로 통합 (제거)
    // 11) 3연봉 반전
    if(d.length>=5){
        const c3=d[d.length-4],c2=d[d.length-3],c1=d[d.length-2];
        if(c3.close<c3.open&&c2.close<c2.open&&c1.close<c1.open&&last.close>last.open){lS+=2;lR.push('3연음→양');}
        if(c3.close>c3.open&&c2.close>c2.open&&c1.close>c1.open&&last.close<last.open){sS+=2;sR.push('3연양→음');}
    }
    // 12) ATR 돌파
    const atr=calcATR(d,14);
    if(atr&&body>atr*1.2){
        if(last.close>last.open){lS+=2;lR.push('ATR돌파↑');}
        if(last.close<last.open){sS+=2;sR.push('ATR돌파↓');}
    }
    // 14) 5봉 돌파
    if(d.length>=6){
        const hi5=Math.max(...d.slice(-6,-1).map(c=>c.high));
        const lo5=Math.min(...d.slice(-6,-1).map(c=>c.low));
        if(last.close>hi5){lS+=2;lR.push('5봉고점돌파');}
        if(last.close<lo5){sS+=2;sR.push('5봉저점이탈');}
    }
    // 15) 공포탐욕 극단
    if(lastFearGreedValue<=20){lS+=2;lR.push('극도공포');}
    if(lastFearGreedValue>=80){sS+=2;sR.push('극도탐욕');}
    // 16) Bybit 롱숏비율 → Binance L/S와 동일 정보 → 제거 (Binance만 사용)
    // 17) Bybit OI 급증 → Binance OI와 동일 정보 → 제거 (Binance만 사용)
    // 23) 차트 패턴
    const cpats=detectChartPatterns(d);
    let cpL=0,cpS=0;cpats.forEach(p=>{if(p.type==='long')cpL+=p.strength;else cpS+=p.strength;});
    if(cpL>60){lS+=2;lR.push('차트패턴롱');}
    if(cpS>60){sS+=2;sR.push('차트패턴숏');}
    // 25) 유동성 스윕
    const sweepSigs=detectLiquiditySweep(d,20);
    if(sweepSigs.length){const ls=sweepSigs[sweepSigs.length-1];
        if(ls.type==='bullish_sweep'&&last.time-ls.time<86400*2){lS+=2;lR.push('유동성스윕↑');}
        if(ls.type==='bearish_sweep'&&last.time-ls.time<86400*2){sS+=2;sR.push('유동성스윕↓');}
    }
    // 26) 와이코프 VSA
    detectWyckoff(d).forEach(w=>{
        if(w.type==='wyckoff_spring'){lS+=2;lR.push('와이코프스프링');}
        if(w.type==='wyckoff_upthrust'){sS+=2;sR.push('와이코프업스러스트');}
    });
    // 27) FVG
    const fvgSigs=detectFVG(d);
    if(fvgSigs.length){const lf=fvgSigs[fvgSigs.length-1];
        if(lf.type==='bullish_fvg'&&price<=lf.top&&price>=lf.bottom){lS+=2;lR.push('상승FVG');}
        if(lf.type==='bearish_fvg'&&price>=lf.bottom&&price<=lf.top){sS+=2;sR.push('하락FVG');}
    }
    // 28) 오더블록 매물대 강화 (강도/신선도/볼륨 반영, 최대 7점)
    const obAdv=detectOrderBlocksAdvanced(d);
    let obLongHit=null,obShortHit=null;
    obAdv.forEach(ob=>{
        // 가격이 OB zone 내부 (±0.2% 허용)
        if(price>=ob.priceLow*0.998&&price<=ob.priceHigh*1.002){
            const pts=Math.min(7,2+ob.strength); // 기본 2 + strength(0~6) → 최대 7
            if(ob.type==='bullish_ob'){
                lS+=pts;
                lR.push(`${ob.untested?'신선':''}OB롱(+${pts})`);
                if(!obLongHit||ob.strength>obLongHit.strength)obLongHit=ob;
            }
            if(ob.type==='bearish_ob'){
                sS+=pts;
                sR.push(`${ob.untested?'신선':''}OB숏(+${pts})`);
                if(!obShortHit||ob.strength>obShortHit.strength)obShortHit=ob;
            }
        }
    });
    // 38) 김프
    if(Math.abs(lastKimchiPremium)>0.01){
        if(lastKimchiPremium>3){sS+=2;sR.push(`김프과열+${lastKimchiPremium.toFixed(1)}%`);}
        else if(lastKimchiPremium<-1){lS+=2;lR.push(`역프${lastKimchiPremium.toFixed(1)}%`);}
    }
    // 39) ADX 추세강도 (신규)
    const adxData=calcADX(d,14);
    if(adxData&&adxData.adx>25){
        if(adxData.plusDI>adxData.minusDI){lS+=2;lR.push(`ADX강세${adxData.adx.toFixed(0)}`);}
        if(adxData.minusDI>adxData.plusDI){sS+=2;sR.push(`ADX약세${adxData.adx.toFixed(0)}`);}
    }
    // 40) ETH 가스 (BTC·ETH 시그널 참고) - 2점
    const _isBTCorETH=currentSymbol==='BTCUSDT'||currentSymbol==='ETHUSDT';
    if(_isBTCorETH&&lastEthGas&&lastEthGas.propose){
        const g=lastEthGas.propose;
        if(g<20){lS+=2;lR.push(`저가스${g.toFixed(0)}G`);}          // 저활동=바닥 시그널
        else if(g>100){sS+=2;sR.push(`고가스${g.toFixed(0)}G`);}    // 과열=조정 시그널
    }
    // 41) ETH CEX 순흐름 - 2점
    if(_isBTCorETH&&lastEthFlow){
        const nf=lastEthFlow.net_flow_eth||0;
        if(nf>500){sS+=2;sR.push(`CEX입금+${nf.toFixed(0)}E`);}   // 입금 급증=매도 압력
        else if(nf<-500){lS+=2;lR.push(`CEX출금${nf.toFixed(0)}E`);} // 출금 급증=매수 의사
    }

    // ⚠️ 49) 청산 클러스터 위험도 — 실데이터(호가창 매물벽) 있을 때만, 약하게 (최대 ±4점)
    // 청산맵의 가우시안 항은 결정론적 추정이므로 신뢰 X. real_data 매물벽만 신호 반영.
    const liqDanger=(lastLiquidationData&&lastLiquidationData.real_data)?analyzeLiquidationDanger(price):null;
    if(liqDanger){
        if(liqDanger.longDanger>=4){ // 강한 매물벽만 (임계 상향)
            const penalty=Math.min(4,Math.round(liqDanger.longDanger*0.5));
            lS=Math.max(0,lS-penalty);
            sS+=Math.min(2,Math.round(liqDanger.longDanger*0.3));
            const cl=liqDanger.maxLongCluster;
            lR.push(`매물벽롱위험-${penalty}@${fp(cl.price)}`);
        }
        if(liqDanger.shortDanger>=4){
            const penalty=Math.min(4,Math.round(liqDanger.shortDanger*0.5));
            sS=Math.max(0,sS-penalty);
            lS+=Math.min(2,Math.round(liqDanger.shortDanger*0.3));
            const cl=liqDanger.maxShortCluster;
            sR.push(`매물벽숏위험-${penalty}@${fp(cl.price)}`);
        }
    }

    // 🎯 50) 다중 시간프레임 우선순위 (주봉>일봉>4h>1h) - 최대 ±15점
    // 큰 시간프레임이 일치할수록 강한 신호
    if(lastMultiTFAnalysis&&lastMultiTFAnalysis.consensus){
        const c=lastMultiTFAnalysis.consensus;
        // MTF 가중치 축소 (15/8 → 8/4): 추세 합의와 부분 중복이라 비중 낮춤
        if(c.bias==='strong_long'){lS+=8;lR.push(`MTF강한롱(주${lastMultiTFAnalysis.tfs['주봉']?.type||'-'},일${lastMultiTFAnalysis.tfs['일봉']?.type||'-'})`);sS=Math.max(0,sS-4);}
        else if(c.bias==='long'){lS+=4;lR.push(`MTF롱우세${c.longPct}%`);sS=Math.max(0,sS-2);}
        else if(c.bias==='strong_short'){sS+=8;sR.push(`MTF강한숏(주${lastMultiTFAnalysis.tfs['주봉']?.type||'-'},일${lastMultiTFAnalysis.tfs['일봉']?.type||'-'})`);lS=Math.max(0,lS-4);}
        else if(c.bias==='short'){sS+=4;sR.push(`MTF숏우세${c.shortPct}%`);lS=Math.max(0,lS-2);}
        // 주봉 단독 강한 신호 (가장 큰 가중)
        const w=lastMultiTFAnalysis.tfs['주봉'];
        // 주봉 풀롱/풀숏: 5 → 3 (추세 합의/MTF와 부분 중복)
        if(w&&w.type==='풀롱'){lS+=3;lR.push('주봉풀롱');}
        else if(w&&w.type==='풀숏'){sS+=3;sR.push('주봉풀숏');}
    }

    // 🎯 51) 다중 시간구간 청산 (12h~1w) - 가까운 청산 타겟에 따른 가중 ±5점 (주식 제외)
    if(!_isStockSym&&lastMultiPeriodLiq&&lastMultiPeriodLiq.periods){
        const periods=lastMultiPeriodLiq.periods;
        // 1주일 lookback 청산 타겟이 현재가 ±5% 이내면 위험
        const week=periods['1주일'];
        if(week){
            const longDist=(price-week.longTarget)/price; // 양수 = 저점 위
            const shortDist=(week.shortTarget-price)/price;
            if(longDist<0.05&&longDist>0){
                lS=Math.max(0,lS-5);
                sS+=3;
                lR.push(`주간롱청산위험@${fp(week.longTarget)}`);
            }
            if(shortDist<0.05&&shortDist>0){
                sS=Math.max(0,sS-5);
                lS+=3;
                sR.push(`주간숏청산위험@${fp(week.shortTarget)}`);
            }
        }
    }

    // 🎯 52) 다중 거래소 OI/L-S 비율 (Binance + Bybit) - ±3점 (주식 제외)
    if(!_isStockSym&&lastMultiExchangeLiq&&lastMultiExchangeLiq.data&&lastMultiExchangeLiq.data.binance){
        const b=lastMultiExchangeLiq.data.binance;
        if(b.oiChange&&b.oiChange>10)sR.push(`Binance OI급증${b.oiChange.toFixed(1)}%`),sS+=2;
        else if(b.oiChange&&b.oiChange<-10)lR.push(`Binance OI급감${b.oiChange.toFixed(1)}%`),lS+=2;
        if(b.lsRatio&&b.lsRatio>2.5){sS+=3;sR.push(`Binance롱과열${b.lsRatio.toFixed(2)}`);} // 롱 너무 많음=청산 위험
        else if(b.lsRatio&&b.lsRatio<0.6){lS+=3;lR.push(`Binance숏과열${b.lsRatio.toFixed(2)}`);} // 숏 너무 많음=숏스퀴즈
    }

    // ── 42) 상위추세 맥락 (MA200) - 2점 + 후처리 부스트 ──
    const htTrend=detectHigherTFTrend(d);
    // 상위추세 → 추세 합의로 통합 (제거)

    // ── 43) 저항/지지 반복 테스트 + 볼륨감소 (맥락별) - 2점 ──
    const grind=detectResistanceGrind(d,htTrend);
    if(grind){
        if(grind.type==='bull_coil'){lS+=2;lR.push('상승압축돌파임박');}
        if(grind.type==='bear_distribution'){sS+=2;sR.push('매물분배');}
    }

    // ── 3점 조건 (6개, 총 18점) ──
    // 9) BB 반등
    const bb=calcBollingerBands(d,20,2);
    if(bb){
        if(prev.low<=bb.lower&&last.close>bb.lower){lS+=3;lR.push('BB하단반등');}
        if(prev.high>=bb.upper&&last.close<bb.upper){sS+=3;sR.push('BB상단반락');}
    }
    // 18) StochRSI 강화 (5가지 패턴 - 최대 9점)
    const stochAna=analyzeStochRSI(d);
    if(stochAna){
        // 과매도 골든크로스 = 강한 롱 (3+2 보너스)
        if(stochAna.oversoldGolden){lS+=5;lR.push('StochRSI과매도골든');}
        else if(stochAna.goldenCross&&stochAna.k<40){lS+=3;lR.push('StochRSI저점골든');}
        else if(stochAna.goldenCross){lS+=2;lR.push('StochRSI골든');}
        // 과매수 데드크로스 = 강한 숏
        if(stochAna.overboughtDead){sS+=5;sR.push('StochRSI과매수데드');}
        else if(stochAna.deadCross&&stochAna.k>60){sS+=3;sR.push('StochRSI고점데드');}
        else if(stochAna.deadCross){sS+=2;sR.push('StochRSI데드');}
        // Hidden Divergence (지속 신호)
        if(stochAna.hiddenBullDiv){lS+=3;lR.push('Stoch히든상승다이버');}
        if(stochAna.hiddenBearDiv){sS+=3;sR.push('Stoch히든하락다이버');}
        // 더블 바텀/탑
        if(stochAna.doubleBottom){lS+=2;lR.push('Stoch더블바텀');}
        if(stochAna.doubleTop){sS+=2;sR.push('Stoch더블탑');}
    }
    // ── CONFLUENCE: 오더블록 + StochRSI 조합 보너스 (최대 +5점) ──
    if(obLongHit&&stochAna){
        const stochBull=stochAna.oversoldGolden||stochAna.hiddenBullDiv||stochAna.doubleBottom||(stochAna.goldenCross&&stochAna.k<35);
        if(stochBull){
            const bonus=obLongHit.untested?5:3;
            lS+=bonus;lR.push(`OB+Stoch공시이(+${bonus})`);
        }
    }
    if(obShortHit&&stochAna){
        const stochBear=stochAna.overboughtDead||stochAna.hiddenBearDiv||stochAna.doubleTop||(stochAna.deadCross&&stochAna.k>65);
        if(stochBear){
            const bonus=obShortHit.untested?5:3;
            sS+=bonus;sR.push(`OB+Stoch공시이(+${bonus})`);
        }
    }
    // 24) RSI 다이버전스
    const rsiDivSigs=detectRSIDivergence(d,rsiData);
    rsiDivSigs.forEach(s=>{
        if(s.type==='bullish_div'){lS+=3;lR.push('RSI상승다이버');}
        if(s.type==='bearish_div'){sS+=3;sR.push('RSI하락다이버');}
    });
    // 35) 이치모쿠 구름
    const ichFS=calcIchimoku(d);
    if(ichFS.senkouA.length&&ichFS.senkouB.length){
        const sa=ichFS.senkouA[ichFS.senkouA.length-1].value;
        const sb=ichFS.senkouB[ichFS.senkouB.length-1].value;
        // 구름위/아래 → 추세 합의로 통합 (제거)
    }
    // 36) 하모닉 패턴
    const harm=detectHarmonic(d);
    if(harm){
        if(harm.bullish){lS+=3;lR.push(harm.name+'강세');}
        else{sS+=3;sR.push(harm.name+'약세');}
    }
    // ── 추세 합의 (다중공선성 방지) ──
    // 추세 관련 5개 지표를 합의(consensus) 방식으로 통합. 같은 정보(추세 방향)를 여러 번 카운트하던
    // 문제 해결: MA7방향 / MA정배열 / m20-m100 / 이치모쿠구름 / 상위추세(htTrend) / BTC추세.
    // 4개+ 일치=강함(+5), 3개=확인(+3), 2개=약함(+1).
    const ma200f=calcSMA(d,200);
    {
        let trendBull=0, trendBear=0;
        const tbList=[], tsList=[];
        // (1) MA7 방향
        if(price>m7){trendBull++;tbList.push('MA7↑');}
        else if(price<m7){trendBear++;tsList.push('MA7↓');}
        // (2) MA 정배열 (가장 강한 추세 신호)
        if(ma7.length&&ma20.length&&ma100.length&&ma200f.length){
            const v7=ma7[ma7.length-1].value, v20=ma20[ma20.length-1].value;
            const v100=ma100[ma100.length-1].value, v200=ma200f[ma200f.length-1].value;
            if(price>v7&&v7>v20&&v20>v100){trendBull++;tbList.push('MA정배열');}
            else if(price<v7&&v7<v20&&v20<v100){trendBear++;tsList.push('MA역배열');}
        }
        // (3) MA20 vs MA100 (중기 추세)
        if(m20>m100){trendBull++;tbList.push('MA20>100');}
        else if(m20<m100){trendBear++;tsList.push('MA20<100');}
        // (4) 이치모쿠 구름
        if(ich&&ich.senkouA.length&&ich.senkouB.length){
            const sa=ich.senkouA[ich.senkouA.length-1].value, sb=ich.senkouB[ich.senkouB.length-1].value;
            if(price>Math.max(sa,sb)){trendBull++;tbList.push('구름위');}
            else if(price<Math.min(sa,sb)){trendBear++;tsList.push('구름아래');}
        }
        // (5) 상위 시간프레임 추세 (htTrend)
        if(htTrend==='bull'){trendBull++;tbList.push('상위추세↑');}
        else if(htTrend==='bear'){trendBear++;tsList.push('상위추세↓');}
        // 합의 점수 부여 + 어떤 지표들이 동의했는지 명시
        if(trendBull>=4){lS+=5;lR.push(`추세합의↑${trendBull}/5 [${tbList.join('·')}]`);}
        else if(trendBull>=3){lS+=3;lR.push(`추세확인↑${trendBull}/5 [${tbList.join('·')}]`);}
        else if(trendBull>=2){lS+=1;lR.push(`약추세↑${trendBull}/5 [${tbList.join('·')}]`);}
        if(trendBear>=4){sS+=5;sR.push(`추세합의↓${trendBear}/5 [${tsList.join('·')}]`);}
        else if(trendBear>=3){sS+=3;sR.push(`추세확인↓${trendBear}/5 [${tsList.join('·')}]`);}
        else if(trendBear>=2){sS+=1;sR.push(`약추세↓${trendBear}/5 [${tsList.join('·')}]`);}
    }
    // 44) Wyckoff Spring / Upthrust - 3점
    const spring=detectWyckoffSpring(d,20);
    if(spring){
        if(spring.type==='bullish_spring'){lS+=3;lR.push('Spring매집');}
        if(spring.type==='bearish_upthrust'){sS+=3;sR.push('Upthrust분배');}
    }
    // 45) Bull Flag / Bear Flag - 2점
    const flag=detectFlag(d);
    if(flag){
        if(flag.type==='bull_flag'){lS+=2;lR.push('상승깃발');}
        if(flag.type==='bear_flag'){sS+=2;sR.push('하락깃발');}
    }
    // 46) 시간대 통계 - 1점 (현재 시각 강세시간이면 롱, 약세시간이면 숏)
    const tp=analyzeTimePatterns(d);
    if(tp){
        const nowHr=new Date().getHours();
        const hStat=tp.hours[nowHr];
        if(hStat&&hStat.n>=5){
            if(hStat.upRate>=60){lS+=1;lR.push(`강세시간${nowHr}h`);}
            else if(hStat.upRate<=40){sS+=1;sR.push(`약세시간${nowHr}h`);}
        }
    }
    // 47) 가격 범위 예측 - 2점 (단기 모멘텀 방향 확률)
    const pr6=predictPriceRange(d,6);
    if(pr6){
        if(pr6.upProb>=65){lS+=2;lR.push(`상방${pr6.upProb}%`);}
        else if(pr6.upProb<=35){sS+=2;sR.push(`하방${100-pr6.upProb}%`);}
    }
    // 48) RSI 사이클 - 2점 (다음 저점 임박=롱, 다음 고점 임박=숏)
    const cyc=detectMarketCycle(d);
    if(cyc&&cyc.nextEvent){
        const ev=cyc.nextEvent;
        if(ev.type==='trough'&&ev.barsRemain<=3){lS+=2;lR.push(`사이클저점${ev.barsRemain}봉`);}
        else if(ev.type==='peak'&&ev.barsRemain<=3){sS+=2;sR.push(`사이클고점${ev.barsRemain}봉`);}
    }

    // ── 후처리: 상위추세 맥락 부스트/억제 (추세추종) ──
    if(htTrend==='bull'){
        lS=Math.round(lS*1.15); // 상승추세에서 롱 +15%
        sS=Math.round(sS*0.85); // 상승추세에서 숏 -15%
    }else if(htTrend==='bear'){
        sS=Math.round(sS*1.15); // 하락추세에서 숏 +15%
        lS=Math.round(lS*0.85); // 하락추세에서 롱 -15%
    }

    // ── 추세 필터: ADX 추세 방향 역행 시 점수 감산 ──
    if(adxData&&adxData.adx>25){
        // 강한 하락추세인데 풀롱 시도 → 롱점수 20% 감산
        if(adxData.minusDI>adxData.plusDI&&lS>sS)lS=Math.round(lS*0.8);
        // 강한 상승추세인데 풀숏 시도 → 숏점수 20% 감산
        if(adxData.plusDI>adxData.minusDI&&sS>lS)sS=Math.round(sS*0.8);
    }

    // ── 거래량 확인: 신호 캔들 거래량이 20봉 평균 미만이면 감산 ──
    if(d.length>=20){
        const avgVol20=d.slice(-20).reduce((a,c)=>a+c.volume,0)/20;
        if(last.volume<avgVol20*0.8){
            lS=Math.round(lS*0.85);sS=Math.round(sS*0.85);
        }
    }

    // ── 49) BTC 추세 필터 (알트 전용 - 가장 중요한 정확도 개선) ──
    const isBTC=currentSymbol==='BTCUSDT';
    const isAlt=currentSymbol.endsWith('USDT')&&!isBTC&&!currentSymbol.startsWith('STK:');
    if(isAlt&&lastBTCTrend.trend!=='neutral'){
        const sl=Math.abs(lastBTCTrend.slopePct);
        if(lastBTCTrend.trend==='bull'){
            lS+=2;lR.push(`BTC강세+${lastBTCTrend.slopePct.toFixed(2)}%`);
            // BTC 강한 상승 → 알트 풀숏 큰폭 감산
            sS=Math.round(sS*(sl>1?0.65:0.8));
        }else if(lastBTCTrend.trend==='bear'){
            sS+=2;sR.push(`BTC약세${lastBTCTrend.slopePct.toFixed(2)}%`);
            lS=Math.round(lS*(sl>1?0.65:0.8));
        }
    }

    // ── 50) USDT 거래대금 필터 (얇은 시장 신호 약화) ──
    if(d.length>=20){
        const turnovers=d.slice(-20).map(c=>c.turnover||c.volume*c.close).filter(v=>v>0);
        if(turnovers.length>=10){
            const avgTurnover=turnovers.reduce((a,b)=>a+b,0)/turnovers.length;
            const lastTurnover=last.turnover||last.volume*last.close;
            if(lastTurnover<avgTurnover*0.5){
                // 거래대금이 평균의 50% 미만 = 매우 얇은 시장 → 30% 감산
                lS=Math.round(lS*0.7);sS=Math.round(sS*0.7);
                lR.push('얇은시장');sR.push('얇은시장');
            }
        }
    }

    // ── 알트는 더 엄격한 임계값 적용 ──
    // TOTAL_MAX=125 기준: 알트 ~48% (60점) / BTC·ETH ~40% (50점)
    // 만점이 ~25점 줄어 트리거 임계도 비례 조정 (약 80% 수준 유지)
    const TRIGGER_MIN=isAlt?48:40; // 이전 60/50
    const OPPOSITE_MAX=isAlt?13:10; // 이전 16/13

    // ── 확인봉 검증 (prev + prev2 봉 방향 체크 강화) ──
    let confirmed=true;
    if(lS>=TRIGGER_MIN||sS>=TRIGGER_MIN){
        const prevBody=prev.close-prev.open;
        const prev2Body=prev2.close-prev2.open;
        const prevM7=ma7.length>=2?ma7[ma7.length-2].value:m7;
        let prevL=0,prevS=0;
        if(rsiPrev<45)prevL++;if(rsiPrev>55)prevS++;
        if(prevBody>0)prevL++;if(prevBody<0)prevS++;
        if(prev.close>prevM7)prevL++;if(prev.close<prevM7)prevS++;
        if(macdHistPrev>0)prevL++;if(macdHistPrev<0)prevS++;
        if(prev2Body>0)prevL++;if(prev2Body<0)prevS++;
        // 알트는 더 엄격: prev 반대방향이면 즉시 확인 실패
        if(isAlt){
            if(lS>=TRIGGER_MIN&&(prevS>=prevL||prevBody<0))confirmed=false;
            if(sS>=TRIGGER_MIN&&(prevL>=prevS||prevBody>0))confirmed=false;
        }else{
            if(lS>=TRIGGER_MIN&&prevS>prevL)confirmed=false;
            if(sS>=TRIGGER_MIN&&prevL>prevS)confirmed=false;
        }
    }

    // ── S/R 근접 보너스: 지지/저항 근처 신호에 +3점 ──
    try{
        const sr=findSRLevels(d);
        if(sr&&sr.length){
            for(const level of sr){
                const dist=Math.abs(price-level)/price;
                if(dist<0.005){
                    if(price>level){lS+=3;lR.push('지지선근접');}
                    if(price<level){sS+=3;sR.push('저항선근접');}
                    break;
                }
            }
        }
    }catch(e){}

    let signal=null;
    if(confirmed&&lS>=TRIGGER_MIN&&sS<OPPOSITE_MAX){
        signal={type:'풀롱',color:'#FFD700',longConds:lS,shortConds:sS,reasons:lR};
    }else if(confirmed&&sS>=TRIGGER_MIN&&lS<OPPOSITE_MAX){
        signal={type:'풀숏',color:'#FF69B4',shortConds:sS,longConds:lS,reasons:sR};
    }

    return{longConds:lS,shortConds:sS,signal,longReasons:lR,shortReasons:sR,totalConds:TOTAL_MAX};
}

// 개별 캔들에 대한 풀롱/풀숏 기술적 조건 검사 (과거 캔들용, 15개 기술적 조건만)
function checkFullSignalAtCandle(d,idx){
    if(idx<30||idx>=d.length)return null;
    const c=d[idx],prev=d[idx-1];
    const price=c.close;
    const slc=d.slice(0,idx+1);
    // 지표 계산
    const rsiData=calcRSI(slc,14);
    if(rsiData.length<2)return null;
    const rsi=rsiData[rsiData.length-1].value;
    const rsiPrev=rsiData[rsiData.length-2].value;
    const macdD=calcMACD(slc);
    const macdH=macdD.hist.length?macdD.hist[macdD.hist.length-1].value:0;
    const macdHP=macdD.hist.length>=2?macdD.hist[macdD.hist.length-2].value:0;
    const ma7=calcSMA(slc,7),ma20=calcSMA(slc,20),ma100=calcSMA(slc,100);
    const m7=ma7.length?ma7[ma7.length-1].value:price;
    const m20=ma20.length?ma20[ma20.length-1].value:price;
    const m100=ma100.length?ma100[ma100.length-1].value:price;
    const body=Math.abs(c.close-c.open);
    const lW=Math.min(c.open,c.close)-c.low;
    const uW=c.high-Math.max(c.open,c.close);

    let lc=0,sc=0; // 가중합 (★ generateFullSignal과 동일한 합의 패턴 적용)
    // ── 모멘텀 합의 (RSI/W%R/CCI 통합) ──
    const wrH=calcWilliamsR(slc,14);
    const cciH=calcCCI(slc,20);
    {
        let momB=0,momR=0;
        if(rsi<35)momB++;else if(rsi>65)momR++;
        if(wrH!==null){if(wrH<-80)momB++;else if(wrH>-20)momR++;}
        if(cciH!==null){if(cciH<-100)momB++;else if(cciH>100)momR++;}
        if(momB>=3)lc+=3;else if(momB>=2)lc+=1;
        if(momR>=3)sc+=3;else if(momR>=2)sc+=1;
    }
    // ── 1점 캔들/거래량 단순 조건 ──
    if(rsi<40&&rsi>rsiPrev)lc+=1;if(rsi>60&&rsi<rsiPrev)sc+=1;  // RSI 방향성
    if(c.close>c.open)lc+=1;if(c.close<c.open)sc+=1;
    if(prev.close<prev.open&&c.close>c.open)lc+=1;if(prev.close>prev.open&&c.close<c.open)sc+=1;
    if(lW>body*1.5&&c.close>c.open)lc+=1;if(uW>body*1.5&&c.close<c.open)sc+=1;

    // ── 볼륨 합의 (거래량↑/VWAP/거래량폭발 통합) ──
    const vwap=calcVWAP(d.slice(Math.max(0,idx-49),idx+1));
    {
        let volB=0,volR=0;
        if(c.volume>prev.volume*1.2){
            if(c.close>c.open)volB++;else if(c.close<c.open)volR++;
        }
        if(price>vwap*1.002)volB++;else if(price<vwap*0.998)volR++;
        if(idx>=3){
            const av2=(d[idx-1].volume+d[idx-2].volume)/2;
            if(av2>0&&c.volume>av2*2){
                if(c.close>c.open)volB++;else if(c.close<c.open)volR++;
            }
        }
        if(volB>=3)lc+=2;else if(volB>=2)lc+=1;
        if(volR>=3)sc+=2;else if(volR>=2)sc+=1;
    }

    // ── 2점 조건 ──
    if(macdH>macdHP)lc+=2;if(macdH<macdHP)sc+=2;
    if(c.low<m20&&c.close>m20)lc+=2;if(c.high>m20&&c.close<m20)sc+=2; // MA20 지지/저항 (반전형)
    // m20>m100 단독 → 추세 합의로 통합 (아래)
    if(idx>=4){const c3=d[idx-3],c2=d[idx-2],c1=d[idx-1];
        if(c3.close<c3.open&&c2.close<c2.open&&c1.close<c1.open&&c.close>c.open)lc+=2;
        if(c3.close>c3.open&&c2.close>c2.open&&c1.close>c1.open&&c.close<c.open)sc+=2;}
    const atr=calcATR(slc,14);if(atr&&body>atr*1.2){if(c.close>c.open)lc+=2;if(c.close<c.open)sc+=2;}
    if(idx>=6){const hi5=Math.max(...d.slice(idx-5,idx).map(x=>x.high));const lo5=Math.min(...d.slice(idx-5,idx).map(x=>x.low));
        if(c.close>hi5)lc+=2;if(c.close<lo5)sc+=2;}
    // 차트패턴
    const cpH=detectChartPatterns(slc);let cpL=0,cpS=0;cpH.forEach(p=>{if(p.type==='long')cpL+=p.strength;else cpS+=p.strength;});
    if(cpL>60)lc+=2;if(cpS>60)sc+=2;
    // FVG
    const fvgH=detectFVG(slc);if(fvgH.length){const lf=fvgH[fvgH.length-1];
        if(lf.type==='bullish_fvg'&&price<=lf.top&&price>=lf.bottom)lc+=2;
        if(lf.type==='bearish_fvg'&&price>=lf.bottom&&price<=lf.top)sc+=2;}
    // 오더블록 매물대 강화 (강도/신선도 반영)
    const obAdvH=detectOrderBlocksAdvanced(slc);
    let obLongHitH=null,obShortHitH=null;
    obAdvH.forEach(ob=>{
        if(price>=ob.priceLow*0.998&&price<=ob.priceHigh*1.002){
            const pts=Math.min(7,2+ob.strength);
            if(ob.type==='bullish_ob'){lc+=pts;if(!obLongHitH||ob.strength>obLongHitH.strength)obLongHitH=ob;}
            if(ob.type==='bearish_ob'){sc+=pts;if(!obShortHitH||ob.strength>obShortHitH.strength)obShortHitH=ob;}
        }
    });

    // ── 3점 조건 ──
    const bb=calcBollingerBands(slc,20,2);
    if(bb){if(prev.low<=bb.lower&&c.close>bb.lower)lc+=3;if(prev.high>=bb.upper&&c.close<bb.upper)sc+=3;}
    // StochRSI 강화 (5가지 패턴)
    const stochAnaH=analyzeStochRSI(slc);
    if(stochAnaH){
        if(stochAnaH.oversoldGolden)lc+=5;
        else if(stochAnaH.goldenCross&&stochAnaH.k<40)lc+=3;
        else if(stochAnaH.goldenCross)lc+=2;
        if(stochAnaH.overboughtDead)sc+=5;
        else if(stochAnaH.deadCross&&stochAnaH.k>60)sc+=3;
        else if(stochAnaH.deadCross)sc+=2;
        if(stochAnaH.hiddenBullDiv)lc+=3;
        if(stochAnaH.hiddenBearDiv)sc+=3;
        if(stochAnaH.doubleBottom)lc+=2;
        if(stochAnaH.doubleTop)sc+=2;
    }
    // CONFLUENCE: OB + StochRSI
    if(obLongHitH&&stochAnaH){
        if(stochAnaH.oversoldGolden||stochAnaH.hiddenBullDiv||stochAnaH.doubleBottom||(stochAnaH.goldenCross&&stochAnaH.k<35)){
            lc+=obLongHitH.untested?5:3;
        }
    }
    if(obShortHitH&&stochAnaH){
        if(stochAnaH.overboughtDead||stochAnaH.hiddenBearDiv||stochAnaH.doubleTop||(stochAnaH.deadCross&&stochAnaH.k>65)){
            sc+=obShortHitH.untested?5:3;
        }
    }
    const divH=detectRSIDivergence(slc,rsiData);
    divH.forEach(s=>{if(s.type==='bullish_div')lc+=3;if(s.type==='bearish_div')sc+=3;});
    const harmH=detectHarmonic(slc);if(harmH){if(harmH.bullish)lc+=3;else sc+=3;}
    // ── 추세 합의 (MA7방향/MA정배열/m20-m100/이치모쿠 구름 통합) ──
    const ma200H=calcSMA(slc,200);
    {
        let tB=0,tR=0;
        if(price>m7)tB++;else if(price<m7)tR++;
        if(ma7.length&&ma20.length&&ma100.length&&ma200H.length){
            const v7=ma7[ma7.length-1].value, v20=ma20[ma20.length-1].value, v100=ma100[ma100.length-1].value;
            if(price>v7&&v7>v20&&v20>v100)tB++;
            else if(price<v7&&v7<v20&&v20<v100)tR++;
        }
        if(m20>m100)tB++;else if(m20<m100)tR++;
        if(slc.length>=52){
            const ichH=calcIchimoku(slc);
            if(ichH.senkouA.length&&ichH.senkouB.length){
                const saH=ichH.senkouA[ichH.senkouA.length-1].value, sbH=ichH.senkouB[ichH.senkouB.length-1].value;
                if(price>Math.max(saH,sbH))tB++;
                else if(price<Math.min(saH,sbH))tR++;
            }
        }
        if(tB>=4)lc+=5;else if(tB>=3)lc+=3;else if(tB>=2)lc+=1;
        if(tR>=4)sc+=5;else if(tR>=3)sc+=3;else if(tR>=2)sc+=1;
    }
    // ── 고급 패턴: Wyckoff Spring + Flag ──
    const springH=detectWyckoffSpring(slc,20);
    if(springH){
        if(springH.type==='bullish_spring')lc+=3;
        if(springH.type==='bearish_upthrust')sc+=3;
    }
    const flagH=detectFlag(slc);
    if(flagH){
        if(flagH.type==='bull_flag')lc+=2;
        if(flagH.type==='bear_flag')sc+=2;
    }
    // ── 가격 예측 + 사이클 (과거 마커용) ──
    const prH=predictPriceRange(slc,6);
    if(prH){
        if(prH.upProb>=65)lc+=2;
        else if(prH.upProb<=35)sc+=2;
    }
    const cycH=detectMarketCycle(slc);
    if(cycH&&cycH.nextEvent){
        const ev=cycH.nextEvent;
        if(ev.type==='trough'&&ev.barsRemain<=3)lc+=2;
        else if(ev.type==='peak'&&ev.barsRemain<=3)sc+=2;
    }
    // 시간대 통계 (해당 캔들의 시간 기준)
    const tpH=analyzeTimePatterns(slc);
    if(tpH){
        const candleHr=new Date(c.time*1000).getHours();
        const hStat=tpH.hours[candleHr];
        if(hStat&&hStat.n>=5){
            if(hStat.upRate>=60)lc+=1;
            else if(hStat.upRate<=40)sc+=1;
        }
    }

    // ── 상위추세 맥락 부스트/억제 (MA200) ──
    const htTrendH=detectHigherTFTrend(slc);
    if(htTrendH==='bull'){lc=Math.round(lc*1.15);sc=Math.round(sc*0.85);}
    else if(htTrendH==='bear'){sc=Math.round(sc*1.15);lc=Math.round(lc*0.85);}

    // ── ADX 추세 필터: 강한 추세 역행 시 감산 ──
    const adxH=calcADX(slc,14);
    if(adxH&&adxH.adx>25){
        if(adxH.plusDI>adxH.minusDI){lc+=2;} // 상승추세 보너스
        else{sc+=2;} // 하락추세 보너스
        if(adxH.minusDI>adxH.plusDI&&lc>sc)lc=Math.round(lc*0.8); // 하락추세 역행 롱 감산
        if(adxH.plusDI>adxH.minusDI&&sc>lc)sc=Math.round(sc*0.8); // 상승추세 역행 숏 감산
    }
    // ── 거래량 필터: 20봉 평균 미만이면 감산 ──
    if(idx>=20){
        const avgVol=d.slice(idx-20,idx).reduce((a,x)=>a+x.volume,0)/20;
        if(c.volume<avgVol*0.8){lc=Math.round(lc*0.85);sc=Math.round(sc*0.85);}
    }
    // ── USDT 거래대금 필터 (얇은 시장 신호 약화) ──
    if(idx>=20){
        const turnovers=d.slice(idx-20,idx).map(x=>x.turnover||x.volume*x.close).filter(v=>v>0);
        if(turnovers.length>=10){
            const avgT=turnovers.reduce((a,b)=>a+b,0)/turnovers.length;
            const lastT=c.turnover||c.volume*c.close;
            if(lastT<avgT*0.5){lc=Math.round(lc*0.7);sc=Math.round(sc*0.7);}
        }
    }
    // ── 연속 캔들 확인: 다음 봉(idx+1)이 같은 방향이어야 유효 ──
    if(idx+1<d.length){
        const next=d[idx+1];
        if(lc>=26&&next.close<next.open)lc=Math.round(lc*0.6); // 더 큰 감산
        if(sc>=26&&next.close>next.open)sc=Math.round(sc*0.6);
    }
    // ── BTC 추세 일치도 (현재 라이브 캐시 사용) ──
    const _isBTC=currentSymbol==='BTCUSDT';
    const _isAlt=currentSymbol.endsWith('USDT')&&!_isBTC&&!currentSymbol.startsWith('STK:');
    if(_isAlt&&lastBTCTrend&&lastBTCTrend.trend!=='neutral'){
        if(lastBTCTrend.trend==='bull')sc=Math.round(sc*0.8);
        else if(lastBTCTrend.trend==='bear')lc=Math.round(lc*0.8);
    }

    // 가중합 기준 (TOTAL_MAX=95에 맞춰 상향): 알트 32+ / BTC 26+
    const TR=_isAlt?32:26;
    const OPP=_isAlt?8:6;
    if(lc>=TR&&sc<OPP)return{type:'풀롱',lc,sc};
    if(sc>=TR&&lc<OPP)return{type:'풀숏',lc,sc};
    return null;
}

// 풀롱/풀숏 마커를 캔들차트에 추가 (과거 + 미래)
function addFullSignalMarkers(d,existingMarkers){
    const markers=[...existingMarkers];

    // 1) 과거 캔들 스캔 (최근 200봉, 매 봉 검사 + 8봉 중복 제거)
    const startIdx=Math.max(30,d.length-200);
    let lastLongIdx=-999,lastShortIdx=-999;
    for(let i=startIdx;i<d.length;i++){
        const sig=checkFullSignalAtCandle(d,i);
        if(sig){
            if(sig.type==='풀롱'&&i-lastLongIdx>8){
                markers.push({time:d[i].time,position:'belowBar',color:'#FFD700',shape:'arrowUp',size:2,text:`풀롱(${sig.lc})`});
                lastLongIdx=i;
            }else if(sig.type==='풀숏'&&i-lastShortIdx>8){
                markers.push({time:d[i].time,position:'aboveBar',color:'#FF69B4',shape:'arrowDown',size:2,text:`풀숏(${sig.sc})`});
                lastShortIdx=i;
            }
        }
    }

    // 2) 현재 시점: 20개 전체 조건 (외부 데이터 포함)
    const result=generateFullSignal(d);
    if(!result)return markers;

    // 예측 패널 렌더링
    try{renderPredictionPanel(d,result);}catch(e){}

    // ── 통일 (Unified Signal): 모든 UI가 generateFullSignal 결과를 따름 ──
    _lastUnifiedSignal=result; // 전역 캐시
    // 안정화된 방향 계산 (뚝심있게 유지)
    const stable=getStableSignalDirection(result.longConds,result.shortConds,result.signal?.type);
    _lastUnifiedSignal.stableDirection=stable;
    // forward-test 로깅: 풀롱/풀숏 트리거 발생 시 기록 (과최적화 방지 실측 검증)
    try{logForwardTest(result);}catch(e){}
    // 현재가 누적 → 페어링(resolve) 시 미해결 신호의 실제 결과 대조에 사용
    try{recordFtPrice(currentSymbol,lastKlineData?.[lastKlineData.length-1]?.close||0);}catch(e){}
    try{
        const dirEl=document.getElementById('signalDirection');
        const scoreEl=document.getElementById('signalScore');
        const reasonEl=document.getElementById('signalReasons');
        if(dirEl){
            const dirMap={
                '풀롱':{text:'⚡ 풀롱 LONG',cls:'long'},
                '풀숏':{text:'⚡ 풀숏 SHORT',cls:'short'},
                '롱':{text:'롱 LONG',cls:'long'},
                '숏':{text:'숏 SHORT',cls:'short'},
                '약한롱':{text:'약한 LONG',cls:'long'},
                '약한숏':{text:'약한 SHORT',cls:'short'},
                '관망':{text:'관망',cls:'neutral'},
            };
            const m=dirMap[stable.direction]||dirMap['관망'];
            dirEl.textContent=m.text;
            dirEl.className='signal-badge '+m.cls;
        }
        if(scoreEl){
            const diff=result.longConds-result.shortConds;
            const isNeutral=stable.direction==='관망';
            const isWeak=stable.direction==='약한롱'||stable.direction==='약한숏';
            let extras='';
            // 안정성 태그 (안정 / 준안정 / 변동중)
            const stMap={
                '안정':{color:'#00d26a',text:'✓ 안정'},
                '준안정':{color:'#FFD700',text:'△ 준안정'},
                '변동중':{color:'#ff9f43',text:'⏳ 변동중'},
            };
            const stb=stMap[stable.stableLevel||'변동중'];
            const heldStr=stable.heldMin>=1?`${stable.heldMin}분`:`${stable.heldSec}초`;
            extras+=` <span style="color:${stb.color};font-size:11px;">${stb.text} (${heldStr})</span>`;
            if(isNeutral)extras+=` <span style="color:#ff4757;font-weight:700;font-size:11px;">⚠ 진입 비추천 (관망)</span>`;
            else if(isWeak)extras+=` <span style="color:#ff9f43;font-weight:700;font-size:11px;">⚠ 약한 신호 - 신중 진입</span>`;
            else if(stable.stableLevel==='변동중')extras+=` <span style="color:#ff9f43;font-weight:700;font-size:11px;">⚠ 방금 변경 - 확정 대기</span>`;
            scoreEl.innerHTML=`롱: ${result.longConds}점 | 숏: ${result.shortConds}점 | 차이: ${diff>=0?'+':''}${diff}${extras}`;
        }
        if(reasonEl){
            const top=(stable.direction.includes('롱')?result.longReasons:result.shortReasons)||[];
            const stockNote=isStock(currentSymbol)?'⚠ 주식 모드: 가격 TA만 (OI/청산/펀딩 N/A) · ':'';
            reasonEl.textContent=stockNote+top.slice(0,6).join(' | ');
        }
    }catch(e){}

    // 시그널 패널 업데이트
    const sigEl=document.getElementById('signalContent');
    if(sigEl){
        // 기존 풀롱/풀숏 태그 제거
        const spans=sigEl.querySelectorAll('span,button');
        spans.forEach(s=>{if(s.textContent.includes('풀롱')||s.textContent.includes('풀숏')||s.classList.contains('full-sig-toggle'))s.remove();});
        // 현재 상태 표시 (가중점수/최대점수)
        const tc=result.totalConds||67;
        const tag=result.signal
            ?(result.signal.type==='풀롱'
                ?`<span style="background:#FFD700;color:#000;padding:6px 16px;border-radius:6px;font-weight:900;font-size:24px;margin-left:10px;animation:pulse 1s infinite;">⚡ 풀롱 (${result.longConds}/${tc})</span>`
                :`<span style="background:#FF69B4;color:#fff;padding:6px 16px;border-radius:6px;font-weight:900;font-size:24px;margin-left:10px;animation:pulse 1s infinite;">⚡ 풀숏 (${result.shortConds}/${tc})</span>`)
            :`<span style="color:var(--text-secondary);font-size:16px;margin-left:10px;">풀롱/풀숏: 롱${result.longConds} 숏${result.shortConds}/${tc}</span>`;
        // 사유 보기 토글 버튼
        const toggleBtn=`<button class="full-sig-toggle" onclick="toggleFullSignalReasons()" style="margin-left:10px;padding:4px 10px;background:rgba(255,255,255,0.08);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;font-size:11px;cursor:pointer;">사유 보기 ▼</button>`;
        sigEl.innerHTML+=tag+toggleBtn;
        // 사유 패널 데이터 저장 (전역)
        _lastFullSignalReasons={
            longReasons:result.longReasons||[],
            shortReasons:result.shortReasons||[],
            longConds:result.longConds,shortConds:result.shortConds,
            totalConds:tc,
            signalType:result.signal?result.signal.type:null,
        };
        renderFullSignalReasonsPanel();
    }

    // 미래 캔들 영역에 항상 풀롱/풀숏 예측 표시
    const intervalSec={'1':60,'5':300,'15':900,'30':1800,'60':3600,'240':14400,'D':86400,'W':604800};
    const intSec=intervalSec[currentInterval]||3600;
    const futureTime=d[d.length-1].time+intSec;
    const futureTime2=d[d.length-1].time+intSec*2;

    const tc=result.totalConds||67;
    if(result.signal){
        if(result.signal.type==='풀롱'){
            markers.push({time:futureTime,position:'belowBar',color:'#FFD700',shape:'arrowUp',size:2,text:`⚡풀롱(${result.longConds}/${tc})`});
            markers.push({time:futureTime2,position:'belowBar',color:'#FFD700',shape:'arrowUp',size:2,text:`풀롱 진입▲`});
        }else{
            markers.push({time:futureTime,position:'aboveBar',color:'#FF69B4',shape:'arrowDown',size:2,text:`⚡풀숏(${result.shortConds}/${tc})`});
            markers.push({time:futureTime2,position:'aboveBar',color:'#FF69B4',shape:'arrowDown',size:2,text:`풀숏 진입▼`});
        }
    }else{
        const isLongBias=result.longConds>result.shortConds;
        const label=isLongBias?`롱 대기(${result.longConds}/${tc})`:`숏 대기(${result.shortConds}/${tc})`;
        const color=isLongBias?'rgba(255,215,0,0.6)':'rgba(255,105,180,0.6)';
        const pos=isLongBias?'belowBar':'aboveBar';
        const shape=isLongBias?'arrowUp':'arrowDown';
        markers.push({time:futureTime,position:pos,color:color,shape:shape,size:2,text:label});
    }

    return markers;
}

/* ═══════════════════════════════════
   갱신 + 이벤트
   ═══════════════════════════════════ */
let refreshCount=0;
async function refreshAll(){
    refreshCount++;
    const stock=isStock(currentSymbol);
    // 시세+차트
    const tasks=[updateTicker()];
    if(stock){
        // 주식: 차트는 15초마다 (Yahoo는 인트라데이도 1분 지연, 1초 갱신 불필요)
        if(refreshCount%15===0||refreshCount===1)tasks.push(updateTVChart());
    }else{
        // 코인: 매 1초 차트 갱신
        tasks.push(updateTVChart());
        // 코인 전용: 호가창
        tasks.push(updateOrderbook());
        // 매 3초: 청산+시장지표
        if(refreshCount%3===0) tasks.push(updateLiquidation(),updateMarketIndicators());
        // 매 10초: 거래량알람 (무거운 API)
        if(refreshCount%10===0) tasks.push(checkAlerts());
        // 매 5초: 김치프리미엄 (실시간 forex 반영)
        if(refreshCount%5===0) tasks.push(updateKimchiPremium());
        // 매 30초: 전문가 컨센서스
        if(refreshCount%30===0) tasks.push(updateExpertConsensus());
        // 매 60초: 온체인 데이터
        if(refreshCount%60===0) tasks.push(updateOnchainData());
        // 매 15초: Etherscan (가스/블록/흐름)
        if(refreshCount%15===0) tasks.push(updateEtherscan());
        // 매 30초: BTC 추세 (알트 정확도 향상용)
        if(refreshCount%30===0||refreshCount===1) tasks.push(updateBTCTrend());
        // 매 1초: 다중 시간프레임 분석 (inflight 락이 자연 throttle)
        tasks.push(updateMultiTimeframeAnalysis());
        // 매 1초: 다중 시간구간 청산 분석 (inflight 락이 자연 throttle)
        tasks.push(updateMultiPeriodLiquidation());
        // 매 30초: 다중 거래소 청산 (외부 API 부담)
        if(refreshCount%30===0||refreshCount===3) tasks.push(updateMultiExchangeLiquidation());
        // 매 50초: 실시간 종목 픽 스캔 (~40개 종목, inflight 락이 자연 throttle)
        if(refreshCount%50===0||refreshCount===4) tasks.push(scanTopPicks());
    }
    // 매크로 데이터는 주식에도 유용 → 항상 갱신
    if(refreshCount%60===0) tasks.push(updateMacroData());
    // 매 15초: 코인니스 속보 (주식 모드에서도 시장 분위기 참고)
    if(refreshCount%15===0||refreshCount===2) tasks.push(updateCoinnessNews());
    // 매 60초: ETH/BTC 국면 (코인만)
    if(!stock&&(refreshCount%60===0||refreshCount===5)) tasks.push(updateEthBtcRegime());
    // 매 30초: 삼각수렴 멀티TF (코인만)
    if(!stock&&(refreshCount%30===0||refreshCount===6)) tasks.push(updateTriangleConvergence());
    // 매 30초: 통합 펀딩비 (코인만)
    if(!stock&&(refreshCount%30===0||refreshCount===7)) tasks.push(updateFundingAggregated());
    // 매 5분: 통합 펀딩비 추이 히스토그램 (8h 정산이라 자주 안 변함)
    if(!stock&&(refreshCount%300===0||refreshCount===8)) tasks.push(updateFundingHistory());
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
    // MTF/청산 데이터 리셋 + 즉시 재계산
    lastMultiTFAnalysis={tfs:{},consensus:null,ts:0};
    lastMultiPeriodLiq={periods:{},ts:0};
    lastMultiExchangeLiq={data:null,ts:0};
    _mtfInflight=false;_mplInflight=false;
    renderMultiTFCard();renderMultiPeriodLiqCard();renderMultiExchangeCard();
    initTVChart().then(()=>{updateTVChart();});
    initRSIChart();initMACDChart();
    // 주식 모드: 호가창 placeholder 즉시 표시
    if(isStock(currentSymbol)){
        updateOrderbook(); // placeholder 렌더
    }
    refreshAll();connectWS();
    // 새 종목 MTF 즉시 갱신
    setTimeout(()=>{updateMultiTimeframeAnalysis();updateMultiPeriodLiquidation();updateMultiExchangeLiquidation();},300);
});
document.getElementById('intervalSelect').addEventListener('change',e=>{currentInterval=e.target.value;updateTVChart();});

/* ═══════════════════════════════════
   종목 검색 드롭다운 (코인 + 주식)
   ═══════════════════════════════════ */

// 클라이언트(브라우저)에서 직접 Bybit API → 모든 USDT 영구선물 가져오기
// Railway 서버는 Bybit CloudFront에 차단되므로 사용자 브라우저에서 처리
async function loadAllBybitSymbols(){
    const PRIORITY=['BTCUSDT','ETHUSDT','SOLUSDT','XRPUSDT','DOGEUSDT','BNBUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','SUIUSDT','PEPEUSDT','WIFUSDT','ARBUSDT','OPUSDT'];
    const BASES=['https://api.bybit.com','https://api.bytick.com'];
    for(const base of BASES){
        try{
            const all=[];
            let cursor='';
            for(let i=0;i<10;i++){
                const u=new URL(base+'/v5/market/instruments-info');
                u.searchParams.set('category','linear');
                u.searchParams.set('limit','1000');
                if(cursor)u.searchParams.set('cursor',cursor);
                const r=await fetch(u.toString());
                if(!r.ok)break;
                const j=await r.json();
                if(j.retCode!==0)break;
                const list=(j.result?.list)||[];
                list.forEach(it=>{
                    if(it.quoteCoin==='USDT'&&it.contractType==='LinearPerpetual'&&it.status==='Trading'){
                        all.push(it.symbol);
                    }
                });
                cursor=j.result?.nextPageCursor||'';
                if(!cursor||!list.length)break;
            }
            if(all.length){
                const set=new Set(all);
                const prio=PRIORITY.filter(s=>set.has(s));
                const rest=[...set].filter(s=>!prio.includes(s)).sort();
                console.log(`[symbols] fetched ${all.length} from ${base}`);
                return prio.concat(rest);
            }
        }catch(e){console.warn('[symbols] '+base+' failed',e);}
    }
    return null;
}

// items 배열은 외부 closure에서 관리 (리프레시 가능)
let _symbolItems=[];
let _symbolSearchInited=false;

function _rebuildSymbolItems(){
    const sel=document.getElementById('symbolSelect');
    if(!sel)return;
    _symbolItems.length=0;
    sel.querySelectorAll('optgroup').forEach(og=>{
        const group=og.label;
        og.querySelectorAll('option').forEach(o=>{
            _symbolItems.push({value:o.value,label:o.textContent.trim(),group});
        });
    });
}

async function refreshSymbolDropdown(){
    const sel=document.getElementById('symbolSelect');
    if(!sel)return;
    const fetched=await loadAllBybitSymbols();
    if(!fetched||!fetched.length)return;
    const og=sel.querySelector('optgroup[label="코인 선물"]');
    if(!og)return;
    const existing=new Set(Array.from(og.querySelectorAll('option')).map(o=>o.value));
    let added=0;
    fetched.forEach(s=>{
        if(!existing.has(s)){
            const opt=document.createElement('option');
            opt.value=s;opt.textContent=s;
            og.appendChild(opt);
            added++;
        }
    });
    console.log(`[symbols] added ${added} new symbols (total ${fetched.length})`);
    // 이벤트 리스너 재등록 X — items만 갱신
    _rebuildSymbolItems();
}

function initSymbolSearch(){
    if(_symbolSearchInited)return;
    const sel=document.getElementById('symbolSelect');
    const btn=document.getElementById('symbolSearchBtn');
    const dd=document.getElementById('symbolSearchDropdown');
    const inp=document.getElementById('symbolSearchInput');
    const list=document.getElementById('symbolSearchList');
    const lbl=document.getElementById('symbolSearchLabel');
    if(!sel||!btn)return;
    _symbolSearchInited=true;

    _rebuildSymbolItems();

    function updateLabel(){
        const cur=_symbolItems.find(i=>i.value===sel.value);
        if(cur)lbl.textContent=cur.label;
    }
    updateLabel();

    function render(query=''){
        const q=query.toLowerCase().trim();
        const filtered=q?_symbolItems.filter(i=>
            i.value.toLowerCase().includes(q)||
            i.label.toLowerCase().includes(q)
        ):_symbolItems;
        if(!filtered.length){
            list.innerHTML='<div style="padding:14px;color:var(--text-secondary);font-size:11px;text-align:center;">검색 결과 없음</div>';
            return;
        }
        let html='';
        let lastGroup='';
        filtered.forEach((it,idx)=>{
            if(it.group!==lastGroup){
                html+=`<div style="padding:6px 12px;font-size:9px;color:var(--text-secondary);background:rgba(255,255,255,0.03);text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">${it.group}</div>`;
                lastGroup=it.group;
            }
            const isSel=it.value===sel.value;
            const isFirstMatch=q&&idx===0;
            const bg=isSel?'rgba(255,215,0,0.12)':isFirstMatch?'rgba(255,255,255,0.05)':'';
            const color=isSel?'var(--yellow)':'var(--text-primary)';
            const fw=isSel?'600':'400';
            html+=`<div class="sym-item" data-val="${it.value}" data-bg="${bg}" style="padding:8px 14px;cursor:pointer;font-size:12px;background:${bg};color:${color};font-weight:${fw};border-left:3px solid ${isSel?'var(--yellow)':'transparent'};">${it.label}</div>`;
        });
        list.innerHTML=html;
        // 이벤트 위임으로 단일 리스너 (이미 list에 한 번만 등록됨)
    }

    function open(){
        dd.style.display='block';
        // 모바일(<=768px): 버튼 바로 아래에 fixed 배치
        if(window.innerWidth<=768){
            const rect=btn.getBoundingClientRect();
            dd.style.top=(rect.bottom+4)+'px';
        }else{
            dd.style.top=''; // 데스크탑은 CSS 기본값
        }
        inp.value='';
        render('');
        setTimeout(()=>inp.focus(),0);
    }
    function close(){dd.style.display='none';}

    // 버튼 클릭
    btn.addEventListener('click',e=>{
        e.stopPropagation();
        if(dd.style.display==='block')close();else open();
    });
    // 검색 입력
    inp.addEventListener('input',()=>render(inp.value));
    inp.addEventListener('keydown',e=>{
        if(e.key==='Escape'){close();btn.focus();}
        if(e.key==='Enter'){
            e.preventDefault();
            const first=list.querySelector('.sym-item');
            if(first)first.click();
        }
    });
    // 리스트 항목 이벤트 위임 (단일 리스너)
    list.addEventListener('click',e=>{
        const item=e.target.closest('.sym-item');
        if(!item)return;
        sel.value=item.dataset.val;
        sel.dispatchEvent(new Event('change',{bubbles:true}));
        updateLabel();
        close();
    });
    list.addEventListener('mouseover',e=>{
        const item=e.target.closest('.sym-item');
        if(item)item.style.background='rgba(255,255,255,0.08)';
    });
    list.addEventListener('mouseout',e=>{
        const item=e.target.closest('.sym-item');
        if(item)item.style.background=item.dataset.bg||'';
    });
    // 외부 클릭 시 닫기 (단일 등록)
    document.addEventListener('click',e=>{
        if(!btn.contains(e.target)&&!dd.contains(e.target))close();
    });
    // select 외부 변경 시 라벨 동기화
    sel.addEventListener('change',updateLabel);
}
initSymbolSearch();
// 모든 Bybit USDT 영구선물을 사용자 브라우저에서 비동기 로드 (items만 갱신)
refreshSymbolDropdown();

/* ═══════════════════════════════════
   풀롱/풀숏 사유 펼치기 패널
   ═══════════════════════════════════ */
let _lastFullSignalReasons=null;
let _fullSigReasonsExpanded=false;

function toggleFullSignalReasons(){
    _fullSigReasonsExpanded=!_fullSigReasonsExpanded;
    renderFullSignalReasonsPanel();
    // 토글 버튼 텍스트 갱신
    const btn=document.querySelector('.full-sig-toggle');
    if(btn)btn.textContent=_fullSigReasonsExpanded?'사유 닫기 ▲':'사유 보기 ▼';
}

function renderFullSignalReasonsPanel(){
    const panel=document.getElementById('fullSignalReasonsPanel');
    if(!panel)return;
    if(!_fullSigReasonsExpanded||!_lastFullSignalReasons){
        panel.style.display='none';
        return;
    }
    const r=_lastFullSignalReasons;
    const lr=r.longReasons.length?r.longReasons:['(만족 조건 없음)'];
    const sr=r.shortReasons.length?r.shortReasons:['(만족 조건 없음)'];
    panel.style.display='block';
    panel.innerHTML=`
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
            <div>
                <div style="color:#FFD700;font-weight:700;font-size:13px;margin-bottom:6px;">롱 사유 (${r.longConds}/${r.totalConds}점)</div>
                <div style="font-size:11px;color:var(--text-primary);line-height:1.7;">
                    ${lr.map(x=>`<span style="display:inline-block;background:rgba(255,215,0,0.12);color:#FFD700;padding:2px 8px;border-radius:3px;margin:2px 3px 2px 0;border:1px solid rgba(255,215,0,0.3);">${x}</span>`).join('')}
                </div>
            </div>
            <div>
                <div style="color:#FF69B4;font-weight:700;font-size:13px;margin-bottom:6px;">숏 사유 (${r.shortConds}/${r.totalConds}점)</div>
                <div style="font-size:11px;color:var(--text-primary);line-height:1.7;">
                    ${sr.map(x=>`<span style="display:inline-block;background:rgba(255,105,180,0.12);color:#FF69B4;padding:2px 8px;border-radius:3px;margin:2px 3px 2px 0;border:1px solid rgba(255,105,180,0.3);">${x}</span>`).join('')}
                </div>
            </div>
        </div>
    `;
}

/* ═══════════════════════════════════
   빨간펜 그리기 오버레이 (OBS 방송용)
   - 우클릭 드래그: 빨간 선 그리기 (15pt)
   - Backspace: 모두 지우기
   - Ctrl/Cmd+P: 펜 ON/OFF 토글
   ═══════════════════════════════════ */
(function initRedPenOverlay(){
    const cv=document.createElement('canvas');
    cv.id='redPenCanvas';
    cv.style.cssText='position:fixed;top:0;left:0;pointer-events:none;z-index:99999;';
    document.body.appendChild(cv);

    // ON/OFF 토글 버튼 (우하단 고정 - 더 크고 눈에 띄게)
    const toggle=document.createElement('div');
    toggle.id='redPenToggle';
    toggle.style.cssText='position:fixed;bottom:20px;right:20px;background:#222;color:#fff;padding:14px 22px;border-radius:50px;font-size:14px;cursor:pointer;z-index:100000;border:3px solid #ff3b3b;font-weight:700;user-select:none;font-family:-apple-system,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,0.5);transition:all 0.2s;';
    toggle.title='클릭 또는 Ctrl/Cmd+P. ON 후 우클릭+드래그로 그리기, Backspace로 지우기';
    document.body.appendChild(toggle);

    // 사용법 안내 툴팁
    const hint=document.createElement('div');
    hint.id='redPenHint';
    hint.style.cssText='position:fixed;bottom:78px;right:20px;background:rgba(255,59,59,0.95);color:#fff;padding:10px 14px;border-radius:6px;font-size:11px;z-index:100000;font-family:-apple-system,sans-serif;max-width:240px;line-height:1.6;pointer-events:none;display:none;';
    hint.innerHTML='<b>방송용 빨간펜</b><br>1) 빨간 버튼 ON<br>2) 우클릭+드래그 = 빨간 선<br>3) Backspace = 마지막 획 지우기 (Undo)<br>4) Shift+Backspace = 모두 지우기';
    document.body.appendChild(hint);
    // 마우스 호버 시 툴팁 표시
    toggle.addEventListener('mouseenter',()=>{hint.style.display='block';});
    toggle.addEventListener('mouseleave',()=>{hint.style.display='none';});

    let penOn=false;
    let drawing=false;
    let strokes=[]; // [[{x,y}, ...], ...]
    let cur=null;
    let dpr=window.devicePixelRatio||1;

    function resize(){
        cv.width=window.innerWidth*dpr;
        cv.height=window.innerHeight*dpr;
        cv.style.width=window.innerWidth+'px';
        cv.style.height=window.innerHeight+'px';
        const ctx=cv.getContext('2d');
        ctx.scale(dpr,dpr);
        redrawAll();
    }

    function redrawAll(){
        const ctx=cv.getContext('2d');
        ctx.setTransform(1,0,0,1,0,0);
        ctx.scale(dpr,dpr);
        ctx.clearRect(0,0,cv.width/dpr,cv.height/dpr);
        ctx.strokeStyle='#ff3b3b';
        ctx.lineWidth=8;
        ctx.lineCap='round';
        ctx.lineJoin='round';
        for(const stroke of strokes){
            if(stroke.length<2)continue;
            ctx.beginPath();
            ctx.moveTo(stroke[0].x,stroke[0].y);
            for(let i=1;i<stroke.length;i++)ctx.lineTo(stroke[i].x,stroke[i].y);
            ctx.stroke();
        }
    }

    function setPen(on){
        penOn=on;
        toggle.textContent=on?'● 펜 ON (우클릭=빨간선)':'펜 OFF (클릭하여 켜기)';
        toggle.style.background=on?'#ff3b3b':'#222';
        toggle.style.color='#fff';
        toggle.style.borderColor=on?'#fff':'#ff3b3b';
    }
    toggle.addEventListener('click',()=>setPen(!penOn));
    setPen(false); // 초기 라벨 적용

    resize();
    window.addEventListener('resize',resize);

    // capture phase로 등록 → 차트 라이브러리보다 먼저 캡처
    window.addEventListener('contextmenu',e=>{
        if(penOn){e.preventDefault();e.stopPropagation();}
    },true);

    window.addEventListener('mousedown',e=>{
        if(!penOn||e.button!==2)return;
        e.preventDefault();e.stopPropagation();
        drawing=true;
        cur=[{x:e.clientX,y:e.clientY}];
    },true);

    window.addEventListener('mousemove',e=>{
        if(!penOn||!drawing)return;
        e.preventDefault();
        cur.push({x:e.clientX,y:e.clientY});
        const ctx=cv.getContext('2d');
        ctx.strokeStyle='#ff3b3b';
        ctx.lineWidth=8;
        ctx.lineCap='round';
        ctx.lineJoin='round';
        const p1=cur[cur.length-2],p2=cur[cur.length-1];
        ctx.beginPath();
        ctx.moveTo(p1.x,p1.y);
        ctx.lineTo(p2.x,p2.y);
        ctx.stroke();
    },true);

    window.addEventListener('mouseup',e=>{
        if(!penOn||e.button!==2)return;
        e.preventDefault();
        if(drawing&&cur&&cur.length>1)strokes.push(cur);
        drawing=false;cur=null;
    },true);

    // Backspace: 마지막 1획만 지우기 (Undo). Shift+Backspace = 모두 지우기
    document.addEventListener('keydown',e=>{
        if(e.key!=='Backspace')return;
        const ae=document.activeElement;
        const tag=ae?ae.tagName:'';
        if(tag==='INPUT'||tag==='TEXTAREA'||(ae&&ae.isContentEditable))return;
        if(!strokes.length&&!drawing)return;
        e.preventDefault();
        // 그리는 중이면 현재 획 취소
        if(drawing){drawing=false;cur=null;}
        // Shift+Backspace → 모두 삭제, 일반 Backspace → 마지막 1획만
        if(e.shiftKey)strokes=[];
        else strokes.pop();
        redrawAll(); // 남은 획만 다시 그림
    });

    // Ctrl/Cmd+P 또는 단축키: 펜 토글
    document.addEventListener('keydown',e=>{
        if((e.ctrlKey||e.metaKey)&&e.key==='p'){
            e.preventDefault();
            setPen(!penOn);
        }
    });
})();

/* ═══════════════════════════════════
   자동매매 제어
   ═══════════════════════════════════ */
let traderConnected=false,autoTradeOn=false,lastAutoTradeTime=0,traderToken='';

// 모든 /api/trader/* 호출은 X-Trader-Token 헤더 필요 (서버 TRADER_TOKEN과 일치해야 함)
function traderHeaders(){return{'Content-Type':'application/json','X-Trader-Token':traderToken};}

async function connectTrader(){
    const key=document.getElementById('apiKey').value;
    const secret=document.getElementById('apiSecret').value;
    traderToken=document.getElementById('traderToken').value.trim();
    const testnet=document.getElementById('tradeMode').value==='testnet';
    if(!traderToken){alert('Trader Token을 입력하세요 (Railway 환경변수 TRADER_TOKEN과 동일한 값)');return;}
    if(!key||!secret){alert('API Key와 Secret을 입력하세요');return;}
    const st=document.getElementById('traderStatus');
    st.textContent='연결 중...';
    try{
        const r=await fetch('/api/trader/connect',{method:'POST',headers:traderHeaders(),body:JSON.stringify({api_key:key,api_secret:secret,testnet})});
        const d=await r.json();
        if(d.status==='connected'){
            traderConnected=true;
            let bal='';try{const coins=d.balance?.result?.list?.[0]?.coin||[];const u=coins.find(c=>c.coin==='USDT');bal=u?` | 잔고: ${parseFloat(u.walletBalance).toFixed(2)} USDT`:'';}catch(e){}
            st.innerHTML=`<span style="color:${G}">연결됨 (${testnet?'테스트넷':'실거래'})${bal}</span>`;
        }else if(d.status==='disabled'){
            st.innerHTML=`<span style="color:${R}">서버에 TRADER_TOKEN 미설정 — Railway 환경변수부터 설정하세요</span>`;
        }else if(d.status==='unauthorized'){
            st.innerHTML=`<span style="color:${R}">토큰 불일치 — Railway TRADER_TOKEN과 입력값이 같은지 확인</span>`;
        }else st.innerHTML=`<span style="color:${R}">실패: ${d.message||d.status}</span>`;
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
    await fetch('/api/trader/config',{method:'POST',headers:traderHeaders(),body:JSON.stringify(cfg)});
    await fetch('/api/trader/toggle',{method:'POST',headers:traderHeaders(),body:JSON.stringify({enabled:autoTradeOn})});
}

// 멀티코인 자동매매 ON/OFF (체크박스). true면 스캐너의 풀롱/풀숏 픽 중 1개를 자동 진입.
let multiCoinAuto=false;
async function checkAutoTrade(){
    if(!autoTradeOn||!traderConnected)return;
    const now=Date.now();
    if(now-lastAutoTradeTime<30000)return; // 30초 쿨다운(요청 폭주 방지)

    let direction='', score=0, price=0, symbol=currentSymbol;

    if(multiCoinAuto){
        // ── 멀티코인: 스캐너(lastTopPicks)에서 가장 강한 풀롱/풀숏 픽 1개 선택 ──
        // ⚠️ 현재 종목 외 코인은 '간소화 신호'(_evaluateTFSignalSimple) 기준임.
        const picks=(lastTopPicks?.picks||[]).filter(p=>
            (p.direction==='풀롱'||p.direction==='풀숏')&&p.price>0);
        if(!picks.length)return;
        // 정렬은 이미 confidence/풀신호 우선 → 첫 번째가 최강
        const top=picks[0];
        symbol=top.symbol;
        direction=top.direction==='풀롱'?'LONG':'SHORT';
        score=Math.max(top.lc,top.sc);
        price=top.price;
    }else{
        // ── 단일코인: 지금 보고 있는 종목의 메인 신호(풀 125점) ──
        const dir=document.getElementById('signalDirection')?.textContent||'';
        const sm=document.getElementById('signalScore')?.textContent?.match(/순: ([+-]?\d+)/);
        const net=sm?parseInt(sm[1]):0;
        price=parseFloat(document.getElementById('tickPrice')?.textContent?.replace(/,/g,'')||0);
        if(dir.includes('LONG')&&net>0)direction='LONG';
        if(dir.includes('SHORT')&&net<0)direction='SHORT';
        score=Math.abs(net);
    }
    if(!direction||!price)return;
    lastAutoTradeTime=now;
    try{
        const r=await fetch('/api/trader/signal-trade',{method:'POST',headers:traderHeaders(),
            body:JSON.stringify({direction,score:Math.abs(score),price,symbol})});
        const d=await r.json();
        if(d.status==='executed')updateTradeLog();
    }catch(e){}
}

async function updateTradeLog(){
    try{
        if(!traderConnected)return;
        const r=await fetch('/api/trader/log',{headers:{'X-Trader-Token':traderToken}}).then(x=>x.json());
        const el=document.getElementById('tradeLog');
        if(!r.log?.length){el.innerHTML='<div style="color:#8b949e;font-size:11px;">매매 기록 없음</div>';return;}
        el.innerHTML=r.log.slice(-10).reverse().map(l=>`<div class="alert-item"><span style="color:${TX};font-size:9px;">${l.testnet?'[테스트]':'[실거래]'}</span><span style="color:${l.side==='Buy'?G:R};font-weight:700;">${l.side==='Buy'?'롱':'숏'}</span><span>${fp(l.price)}</span><span style="color:${G}">TP:${l.tp}</span><span style="color:${R}">SL:${l.sl}</span><span style="font-size:9px;">${l.result}</span></div>`).join('');
    }catch(e){}
}

/* ═══════════════════════════════════
   백테스팅 시스템: 각 코인별로 풀롱/풀숏 시그널을 과거 캔들에 적용
   TP +2% / SL -1% / 24봉 내 청산 / 1h 봉 500개 기준
   ═══════════════════════════════════ */
const BACKTEST_TP=0.02,BACKTEST_SL=0.01,BACKTEST_HOLD=24;

async function runBacktestForSymbol(symbol){
    const candles=await bybitKline(symbol,'60',500).catch(()=>null);
    if(!candles||candles.length<150)return null;
    const trades=[];
    // 인디케이터 워밍업 50봉, 청산용 마지막 24봉 제외
    for(let i=50;i<candles.length-BACKTEST_HOLD;i++){
        const sig=checkFullSignalAtCandle(candles,i);
        if(!sig)continue;
        const isLong=sig.type==='풀롱';
        const entry=candles[i].close;
        const tpPrice=isLong?entry*(1+BACKTEST_TP):entry*(1-BACKTEST_TP);
        const slPrice=isLong?entry*(1-BACKTEST_SL):entry*(1+BACKTEST_SL);
        let result=null;
        for(let j=i+1;j<=Math.min(i+BACKTEST_HOLD,candles.length-1);j++){
            const c=candles[j];
            if(isLong){
                if(c.low<=slPrice){result={win:false,pnl:-BACKTEST_SL*100,bars:j-i};break;}
                if(c.high>=tpPrice){result={win:true,pnl:BACKTEST_TP*100,bars:j-i};break;}
            }else{
                if(c.high>=slPrice){result={win:false,pnl:-BACKTEST_SL*100,bars:j-i};break;}
                if(c.low<=tpPrice){result={win:true,pnl:BACKTEST_TP*100,bars:j-i};break;}
            }
        }
        if(!result){
            const exit=candles[Math.min(i+BACKTEST_HOLD,candles.length-1)].close;
            const pnl=isLong?(exit-entry)/entry*100:(entry-exit)/entry*100;
            result={win:pnl>0,pnl,bars:BACKTEST_HOLD};
        }
        trades.push({idx:i,time:candles[i].time,type:sig.type,entry,...result});
        // 같은 시그널 중복 방지: 다음 진입은 청산 후로 점프
        i+=Math.max(1,result.bars-1);
    }
    if(!trades.length)return{symbol,trades:0,wins:0,losses:0,winRate:0,avgPnL:0,totalPnL:0,maxDD:0,longCount:0,shortCount:0,trades_detail:[]};
    const wins=trades.filter(t=>t.win).length;
    const longCount=trades.filter(t=>t.type==='풀롱').length;
    const shortCount=trades.length-longCount;
    const totalPnL=trades.reduce((s,t)=>s+t.pnl,0);
    let peak=0,equity=0,maxDD=0;
    trades.forEach(t=>{equity+=t.pnl;peak=Math.max(peak,equity);maxDD=Math.min(maxDD,equity-peak);});
    return{
        symbol,
        trades:trades.length,wins,losses:trades.length-wins,
        winRate:Math.round(wins/trades.length*1000)/10,
        avgPnL:Math.round(totalPnL/trades.length*100)/100,
        totalPnL:Math.round(totalPnL*10)/10,
        maxDD:Math.round(maxDD*10)/10,
        longCount,shortCount,
        trades_detail:trades.map(t=>({time:t.time,pnl:t.pnl})),
    };
}

let backtestRunning=false;
async function runAllBacktests(){
    if(backtestRunning)return;
    backtestRunning=true;
    const btn=document.getElementById('btnBacktestAll');
    const prog=document.getElementById('backtestProgress');
    let symbols=[];
    try{
        const sym=await fetchJSON('/api/symbols');
        symbols=sym.symbols||[];
    }catch(e){
        symbols=Array.from(document.querySelectorAll('#symbolSelect optgroup[label="코인 선물"] option')).map(o=>o.value);
    }
    if(btn){btn.disabled=true;btn.textContent='실행 중...';}
    let done=0;
    let allTrades=[]; // 전 종목 거래 모아서 자산곡선 생성
    for(const s of symbols){
        try{
            const r=await runBacktestForSymbol(s);
            if(r){
                if(r.trades_detail&&r.trades_detail.length)allTrades.push(...r.trades_detail);
                // 저장은 거래 상세 빼고 통계만 (저장 용량 절약)
                const {trades_detail,...statsOnly}=r;
                await fetch('/api/backtest/save',{
                    method:'POST',headers:{'Content-Type':'application/json'},
                    body:JSON.stringify(statsOnly),
                });
            }
        }catch(e){console.warn('backtest fail',s,e);}
        done++;
        if(prog)prog.textContent=`${done}/${symbols.length} (${s})`;
        // 매 5종목마다 UI 갱신
        if(done%5===0)renderBacktestResults();
        await new Promise(r=>setTimeout(r,150));
    }
    // 자산 곡선: 시간순 정렬 후 누적 손익 (각 거래 동일 비중 가정, 단순 합산 %)
    allTrades.sort((a,b)=>a.time-b.time);
    let eq=0;
    const curve=allTrades.map(t=>{eq+=t.pnl;return{time:t.time,equity:Math.round(eq*100)/100};});
    try{
        await fetch('/api/backtest/save',{
            method:'POST',headers:{'Content-Type':'application/json'},
            body:JSON.stringify({symbol:'_equity',curve}),
        });
    }catch(e){}
    if(btn){btn.disabled=false;btn.textContent='전체 백테스팅 실행';}
    if(prog)prog.textContent=`완료: ${done}개`;
    renderBacktestResults();
    backtestRunning=false;
}

async function clearBacktests(){
    if(!confirm('백테스트 결과 모두 삭제?'))return;
    await fetch('/api/backtest/clear',{method:'POST'});
    renderBacktestResults();
}

async function renderBacktestResults(){
    const el=document.getElementById('backtestResults');
    if(!el)return;
    let data={};
    try{data=await fetchJSON('/api/backtest');}catch(e){}
    // '_'로 시작하는 키(_equity 등)는 표에서 제외
    const arr=Object.values(data).filter(r=>r&&r.symbol&&!String(r.symbol).startsWith('_'));
    // 자산 곡선 그리기 (있으면)
    drawBacktestEquity(data['_equity']?.curve);
    if(!arr.length){
        el.innerHTML='<div style="color:var(--text-secondary);font-size:11px;padding:14px;text-align:center;">백테스트 데이터 없음. <b>"전체 백테스팅 실행"</b> 클릭하세요.<br>(1h 캔들 500봉 / TP +2% / SL -1% / 최대 24봉 보유)</div>';
        return;
    }
    arr.sort((a,b)=>(b.totalPnL||0)-(a.totalPnL||0));
    const totalTrades=arr.reduce((s,r)=>s+(r.trades||0),0);
    const totalWins=arr.reduce((s,r)=>s+(r.wins||0),0);
    const overallWR=totalTrades>0?(totalWins/totalTrades*100):0;
    const totalPnL=arr.reduce((s,r)=>s+(r.totalPnL||0),0);
    el.innerHTML=`
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin-bottom:8px;font-size:11px;">
            <div style="background:rgba(0,210,106,0.1);padding:6px;border-radius:4px;text-align:center;border-left:3px solid ${G}">
                <div style="color:var(--text-secondary);font-size:9px;">전체 거래</div>
                <div style="color:${G};font-size:14px;font-weight:700;">${totalTrades}</div>
            </div>
            <div style="background:rgba(240,185,11,0.1);padding:6px;border-radius:4px;text-align:center;border-left:3px solid ${YL}">
                <div style="color:var(--text-secondary);font-size:9px;">평균 승률</div>
                <div style="color:${overallWR>=55?G:overallWR<45?R:YL};font-size:14px;font-weight:700;">${overallWR.toFixed(1)}%</div>
            </div>
            <div style="background:rgba(88,166,255,0.1);padding:6px;border-radius:4px;text-align:center;border-left:3px solid #58a6ff">
                <div style="color:var(--text-secondary);font-size:9px;">종목수</div>
                <div style="color:#58a6ff;font-size:14px;font-weight:700;">${arr.length}</div>
            </div>
            <div style="background:${totalPnL>=0?'rgba(0,210,106,0.1)':'rgba(255,71,87,0.1)'};padding:6px;border-radius:4px;text-align:center;border-left:3px solid ${totalPnL>=0?G:R}">
                <div style="color:var(--text-secondary);font-size:9px;">총손익(누적)</div>
                <div style="color:${totalPnL>=0?G:R};font-size:14px;font-weight:700;">${totalPnL>=0?'+':''}${totalPnL.toFixed(1)}%</div>
            </div>
        </div>
        <table style="width:100%;font-size:11px;border-collapse:collapse;">
            <thead><tr style="color:var(--text-secondary);border-bottom:1px solid var(--border);">
                <th style="text-align:left;padding:4px;">종목</th>
                <th style="text-align:right;padding:4px;">거래</th>
                <th style="text-align:center;padding:4px;">L/S</th>
                <th style="text-align:right;padding:4px;">승률</th>
                <th style="text-align:right;padding:4px;">평균</th>
                <th style="text-align:right;padding:4px;">총손익</th>
                <th style="text-align:right;padding:4px;">MDD</th>
            </tr></thead>
            <tbody>
            ${arr.map(r=>{
                const wrColor=r.winRate>=60?G:r.winRate<40?R:YL;
                const pnlColor=r.totalPnL>0?G:R;
                return `<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                    <td style="padding:4px 5px;font-weight:600;color:var(--text-primary);">${r.symbol}</td>
                    <td style="text-align:right;padding:4px;">${r.trades}</td>
                    <td style="text-align:center;padding:4px;font-size:10px;color:var(--text-secondary);">${r.longCount}/${r.shortCount}</td>
                    <td style="text-align:right;padding:4px;color:${wrColor};font-weight:600;">${r.winRate}%</td>
                    <td style="text-align:right;padding:4px;color:${pnlColor};">${r.avgPnL>=0?'+':''}${r.avgPnL}%</td>
                    <td style="text-align:right;padding:4px;color:${pnlColor};font-weight:700;">${r.totalPnL>=0?'+':''}${r.totalPnL}%</td>
                    <td style="text-align:right;padding:4px;color:${R};">${r.maxDD}%</td>
                </tr>`;
            }).join('')}
            </tbody>
        </table>
    `;
}

// 자산 곡선 차트 (Chart.js). curve = [{time, equity}]
let _backtestChartInst=null;
function drawBacktestEquity(curve){
    const wrap=document.getElementById('backtestChartWrap');
    const cv=document.getElementById('backtestChart');
    if(!wrap||!cv||typeof Chart==='undefined')return;
    if(!curve||!curve.length){wrap.style.display='none';return;}
    wrap.style.display='';
    const labels=curve.map(p=>{
        const d=new Date(p.time*1000);
        return `${d.getMonth()+1}/${d.getDate()}`;
    });
    const eq=curve.map(p=>p.equity);
    if(_backtestChartInst){try{_backtestChartInst.destroy();}catch(e){}}
    _backtestChartInst=new Chart(cv,{
        type:'line',
        data:{labels,datasets:[{
            label:'누적 손익 %',
            data:eq,
            borderColor:eq[eq.length-1]>=0?'#00d26a':'#ff4757',
            backgroundColor:eq[eq.length-1]>=0?'rgba(0,210,106,0.12)':'rgba(255,71,87,0.12)',
            borderWidth:1.5,pointRadius:0,fill:true,tension:0.1,
        }]},
        options:{
            responsive:true,maintainAspectRatio:false,
            plugins:{legend:{display:false},
                tooltip:{callbacks:{label:c=>` ${c.parsed.y>=0?'+':''}${c.parsed.y.toFixed(2)}%`}}},
            scales:{
                x:{ticks:{color:'#8b949e',maxTicksLimit:8,font:{size:9}},grid:{color:'rgba(255,255,255,0.05)'}},
                y:{ticks:{color:'#8b949e',font:{size:9},callback:v=>(v>=0?'+':'')+v+'%'},grid:{color:'rgba(255,255,255,0.05)'}},
            },
        },
    });
}

/* ═══════════════════════════════════
   코인니스 속보 (실시간 한국어 크립토 뉴스)
   ═══════════════════════════════════ */
let _coinnessLastIds=new Set();
// 중요 속보 처리: 사용자가 닫은 ID 기록 + 마지막으로 표시한 ID(애니메이션 트리거용)
let _coinnessDismissedImportant=new Set();
let _coinnessLastImportantShown=null;
let _lastCoinnessItems=[];

// 진짜 큰 속보 판정: API의 isImportant 플래그 + 강한 반응 폭주(보조)
function _isBigCoinnessNews(it){
    if(it.isImportant)return true;
    const total=(it.bullCount||it.bull||0)+(it.bearCount||it.bear||0);
    // 독자 반응 매우 활발(>=300) + 최근 2시간 내면 큰 뉴스로 간주
    if(total>=300){
        const ageH=(Date.now()-new Date(it.publishAt).getTime())/3600000;
        if(ageH<=2)return true;
    }
    return false;
}

function showImportantCoinnessAlert(items){
    const bar=document.getElementById('coinnessAlertBar');
    if(!bar)return;
    const big=items.filter(it=>_isBigCoinnessNews(it)&&!_coinnessDismissedImportant.has(it.id));
    if(!big.length){bar.style.display='none';bar.classList.remove('new-arrival');return;}
    const it=big[0]; // 최신 한 건
    const ts=new Date(it.publishAt);
    const hh=String(ts.getHours()).padStart(2,'0');
    const mm=String(ts.getMinutes()).padStart(2,'0');
    const codes=(it.originCodes||[]).slice(0,4).join(' ');
    const moreCount=big.length-1;
    const bull=it.bullCount||it.bull||0, bear=it.bearCount||it.bear||0;
    const sentTxt=(bull+bear)>0?`긍정 ${bull} / 부정 ${bear}`:'';
    bar.style.display='';
    bar.innerHTML=`
        <div style="display:flex;align-items:center;gap:14px;font-size:13px;flex-wrap:wrap;">
            <span style="background:#ff4757;color:#fff;font-size:10px;font-weight:800;padding:3px 8px;border-radius:3px;white-space:nowrap;letter-spacing:0.5px;">중요 속보</span>
            <span style="color:var(--text-secondary);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums;">${hh}:${mm}</span>
            <span style="flex:1;min-width:200px;color:var(--text-primary);font-weight:700;line-height:1.3;">${it.title}</span>
            ${codes?`<span style="color:#FFD700;font-size:11px;font-weight:600;white-space:nowrap;">${codes}</span>`:''}
            ${sentTxt?`<span style="color:var(--text-secondary);font-size:10px;white-space:nowrap;">${sentTxt}</span>`:''}
            ${moreCount>0?`<span style="background:rgba(255,255,255,0.1);color:var(--text-primary);font-size:10px;padding:2px 6px;border-radius:3px;white-space:nowrap;">+${moreCount}건 더</span>`:''}
            <button onclick="dismissCoinnessImportant(${it.id})" title="닫기" style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:var(--text-primary);font-size:18px;cursor:pointer;padding:0 10px;line-height:1;border-radius:4px;height:28px;">×</button>
        </div>
    `;
    // 새로 뜬 큰 속보면 한 번 반짝 (animation)
    if(_coinnessLastImportantShown!==it.id){
        _coinnessLastImportantShown=it.id;
        bar.classList.remove('new-arrival');
        // reflow trigger for restart animation
        void bar.offsetWidth;
        bar.classList.add('new-arrival');
    }
}

function dismissCoinnessImportant(id){
    _coinnessDismissedImportant.add(id);
    showImportantCoinnessAlert(_lastCoinnessItems);
}

// 코인니스 속보 → BTC 롱/숏 분석
// 입력: items (속보 배열, 최신 순)
// 방법: 독자 반응(bull/bear 카운트) + 한국어 키워드 매칭 + BTC 관련도 + 최신성 + 중요 가중
const _COINNESS_BULL_KW=['상승','돌파','호재','강세','반등','신고가','상승세','회복','급등','매집','승인','채택','지지','매수세'];
const _COINNESS_BEAR_KW=['하락','청산','폭락','약세','급락','신저가','손절','조정','매도세','우려','리스크','거부','경고','매도','해킹'];
function analyzeCoinnessBTCSentiment(items){
    if(!items||!items.length)return null;
    let bullScore=0,bearScore=0,btcRelated=0;
    const now=Date.now();
    const analyzed=Math.min(items.length,30);
    for(let i=0;i<analyzed;i++){
        const it=items[i];
        const text=((it.title||'')+' '+(it.content||''));
        const codes=it.originCodes||[];
        const isBTC=codes.includes('BTC')||/비트코인|BTC\b/i.test(text);
        if(isBTC)btcRelated++;
        // 시간 가중치 (최근 1시간 = 1.0, 그 이후 감쇠)
        const ageH=(now-new Date(it.publishAt).getTime())/3600000;
        const recencyW=Math.max(0.3,1.0-ageH*0.08);
        // 가중치: BTC 1.6배, 중요 2배
        const w=recencyW*(isBTC?1.6:0.7)*(it.isImportant?2.0:1.0);
        // 독자 반응
        bullScore+=(it.bullCount||it.bull||0)*w;
        bearScore+=(it.bearCount||it.bear||0)*w;
        // 키워드 매칭 (강하게 가중)
        let kbull=0,kbear=0;
        for(const k of _COINNESS_BULL_KW)if(text.includes(k))kbull++;
        for(const k of _COINNESS_BEAR_KW)if(text.includes(k))kbear++;
        bullScore+=kbull*w*5;
        bearScore+=kbear*w*5;
    }
    const total=bullScore+bearScore;
    if(total<5)return{direction:'데이터 부족',bullPct:50,bullScore:0,bearScore:0,btcRelated,analyzed};
    const bullPct=Math.round(bullScore/total*100);
    let direction,color;
    if(bullPct>=62){direction='강한 롱 우세';color='#FFD700';}
    else if(bullPct>=55){direction='롱 우세';color='#00d26a';}
    else if(bullPct<=38){direction='강한 숏 우세';color='#FF69B4';}
    else if(bullPct<=45){direction='숏 우세';color='#ff4757';}
    else{direction='중립';color='#8b949e';}
    return{direction,color,bullPct,bearPct:100-bullPct,
        bullScore:Math.round(bullScore),bearScore:Math.round(bearScore),
        btcRelated,analyzed};
}

async function updateCoinnessNews(){
    const el=document.getElementById('coinnessNews');
    if(!el)return;
    try{
        const r=await fetch('/api/coinness').then(x=>x.json());
        if(!r||!Array.isArray(r.list))return;
        const items=r.list.slice(0,20);
        _lastCoinnessItems=items;
        // 중요 속보 상단 알림 띄우기 (있으면)
        showImportantCoinnessAlert(items);
        if(!items.length){el.innerHTML='<div style="color:var(--text-secondary);font-size:11px;padding:8px;">속보 없음</div>';return;}
        // 신규 항목 카운트 (이전 호출 대비)
        let newCount=0;
        const curIds=new Set(items.map(i=>i.id));
        for(const i of items)if(!_coinnessLastIds.has(i.id))newCount++;
        if(_coinnessLastIds.size>0&&newCount>0){
            const badge=document.getElementById('coinnessNew');
            if(badge){badge.textContent=`+${newCount} NEW`;badge.style.display='inline-block';setTimeout(()=>{badge.style.display='none';},5000);}
        }
        _coinnessLastIds=curIds;

        // ── BTC 분석 박스 ──
        const sent=analyzeCoinnessBTCSentiment(items);
        let analysisHTML='';
        if(sent){
            const barL=sent.bullPct, barS=sent.bearPct;
            analysisHTML=`<div style="background:rgba(255,255,255,0.03);border-left:3px solid ${sent.color};border-radius:4px;padding:8px 10px;margin-bottom:8px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                    <span style="font-size:11px;color:var(--text-secondary);">속보 기반 BTC 신호</span>
                    <span style="font-size:14px;font-weight:700;color:${sent.color};">${sent.direction}</span>
                </div>
                <div style="display:flex;height:14px;border-radius:3px;overflow:hidden;background:rgba(255,255,255,0.06);">
                    <div style="width:${barL}%;background:#00d26a;display:flex;align-items:center;justify-content:center;font-size:9px;color:#000;font-weight:700;">${barL>15?`롱 ${barL}%`:''}</div>
                    <div style="width:${barS}%;background:#ff4757;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff;font-weight:700;">${barS>15?`숏 ${barS}%`:''}</div>
                </div>
                <div style="font-size:9px;color:var(--text-secondary);margin-top:4px;">
                    분석 ${sent.analyzed}건 (BTC 관련 ${sent.btcRelated}건) · 롱점수 ${sent.bullScore} / 숏점수 ${sent.bearScore}
                    <br>※ 독자 반응 + 한국어 키워드 가중. 보조 지표일 뿐 단독 매매 신호 아님.
                </div>
            </div>`;
        }

        // ── 속보 목록 (이모지 제거, 텍스트만) ──
        const listHTML=items.map(it=>{
            const ts=new Date(it.publishAt);
            const hh=String(ts.getHours()).padStart(2,'0');
            const mm=String(ts.getMinutes()).padStart(2,'0');
            const bull=it.bullCount||it.bull||0, bear=it.bearCount||it.bear||0;
            const total=bull+bear;
            let sentTxt='중립', sentColor='#8b949e';
            if(total>0){
                if(bull>bear){sentTxt=`긍정 ${bull} / 부정 ${bear}`;sentColor='#00d26a';}
                else if(bear>bull){sentTxt=`긍정 ${bull} / 부정 ${bear}`;sentColor='#ff4757';}
                else{sentTxt=`긍정 ${bull} / 부정 ${bear}`;}
            }
            const codes=(it.originCodes||[]).slice(0,4).join(' ');
            const important=it.isImportant?'<span style="background:#ff4757;color:#fff;font-size:8px;padding:1px 4px;border-radius:2px;margin-right:4px;font-weight:700;">중요</span>':'';
            return `<div style="border-bottom:1px solid rgba(255,255,255,0.06);padding:6px 4px;font-size:11px;line-height:1.4;">
                <div style="display:flex;justify-content:space-between;align-items:start;gap:8px;">
                    <div style="flex:1;color:var(--text-primary);font-weight:600;">${important}${it.title}</div>
                    <div style="color:var(--text-secondary);font-size:9px;white-space:nowrap;">${hh}:${mm}</div>
                </div>
                <div style="margin-top:2px;color:var(--text-secondary);font-size:9px;">
                    ${codes?`<span style="color:#FFD700;">${codes}</span> · `:''}<span style="color:${sentColor};">${sentTxt}</span>
                </div>
            </div>`;
        }).join('');

        el.innerHTML=analysisHTML+listHTML;
    }catch(e){}
}

/* ═══════════════════════════════════
   ETH/BTC 비율 & 시장 국면 (알트시즌 / 도미넌스 프록시)
   ※ 컨텍스트 표시용. 매매신호 점수에는 미반영.
   ═══════════════════════════════════ */
let _ethBtcWeekChart=null, _ethBtcDayChart=null;
async function binanceKlines(symbol,interval,limit){
    try{
        const r=await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
        if(!r.ok)return null;
        const a=await r.json();
        return a.map(k=>({t:k[0],o:+k[1],h:+k[2],l:+k[3],c:+k[4]}));
    }catch(e){return null;}
}
function _drawRatioChart(canvasId,prevInst,rows){
    const cv=document.getElementById(canvasId);
    if(!cv||typeof Chart==='undefined'||!rows||!rows.length)return prevInst;
    const labels=rows.map(p=>{const d=new Date(p.t);return `${d.getMonth()+1}/${d.getDate()}`;});
    const vals=rows.map(p=>p.c);
    const up=vals[vals.length-1]>=vals[0];
    const lineC=up?'#00d26a':'#ff4757';
    if(prevInst){try{prevInst.destroy();}catch(e){}}
    return new Chart(cv,{type:'line',
        data:{labels,datasets:[{data:vals,borderColor:lineC,backgroundColor:up?'rgba(0,210,106,0.08)':'rgba(255,71,87,0.08)',borderWidth:1.5,pointRadius:0,fill:true,tension:0.15}]},
        options:{responsive:true,maintainAspectRatio:false,
            plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' ETH/BTC '+c.parsed.y.toFixed(6)}}},
            scales:{x:{ticks:{color:'#8b949e',maxTicksLimit:7,font:{size:9}},grid:{color:'rgba(255,255,255,0.04)'}},
                y:{ticks:{color:'#8b949e',font:{size:9},callback:v=>v.toFixed(4)},grid:{color:'rgba(255,255,255,0.04)'}}}}});
}
async function updateEthBtcRegime(){
    if(isStock(currentSymbol))return;
    try{
        const [wk,dy]=await Promise.all([
            binanceKlines('ETHBTC','1w',60),
            binanceKlines('ETHBTC','1d',90),
        ]);
        if(wk&&wk.length>=2) _ethBtcWeekChart=_drawRatioChart('ethBtcWeekChart',_ethBtcWeekChart,wk);
        if(dy&&dy.length>=2) _ethBtcDayChart=_drawRatioChart('ethBtcDayChart',_ethBtcDayChart,dy);
        const regEl=document.getElementById('ethBtcRegime');
        const roEl=document.getElementById('ethBtcReadout');
        if(wk&&wk.length>=5){
            const cur=wk[wk.length-1];      // 진행 중 주봉
            const prevW=wk[wk.length-2];     // 직전 완료 주봉
            const ratio=cur.c;
            const weeklyUp=prevW.c>=prevW.o; // 직전 완료 주봉 방향
            const ago4=wk[wk.length-5].c;
            const trend4=ago4>0?(ratio-ago4)/ago4*100:0;
            let regime,regimeColor;
            if(trend4>3){regime='알트 우호 (도미넌스↓ 압력)';regimeColor='#00d26a';}
            else if(trend4<-3){regime='BTC 우위 (도미넌스↑)';regimeColor='#FF69B4';}
            else{regime='중립 / 횡보';regimeColor='#8b949e';}
            if(regEl)regEl.innerHTML=`<span style="color:${regimeColor}">${regime}</span>`;
            const ethFlag=weeklyUp
                ?`<span style="color:#00d26a;font-weight:700;">직전 주봉 상승 마감: 이더 현물 매수 고려 구간</span>`
                :`<span style="color:#FF69B4;">직전 주봉 하락 마감 → 이더 진입 보류</span>`;
            if(roEl)roEl.innerHTML=`현재 ETH/BTC <b>${ratio.toFixed(6)}</b> · 4주 추세 <b style="color:${trend4>=0?'#00d26a':'#ff4757'}">${trend4>=0?'+':''}${trend4.toFixed(1)}%</b><br>${ethFlag}`;
        }
    }catch(e){console.warn('ethbtc',e);}
}

/* ═══════════════════════════════════
   삼각수렴 멀티TF (프랙탈) + 중간값(중앙선) 회귀 타겟
   ※ 검증 안 된 가설. 매매신호 점수에는 미반영. 차트 보조 판단용.
   ═══════════════════════════════════ */
function detectConvergence(d,lookback=70){
    if(!d||d.length<30)return null;
    const slc=d.slice(-lookback);
    const pv=findPivots(slc,4,4);
    if(pv.highs.length<2||pv.lows.length<2)return null;
    const H=pv.highs.slice(-3), L=pv.lows.slice(-3);
    const hi1=H[0], hi2=H[H.length-1], lo1=L[0], lo2=L[L.length-1];
    if(hi2.idx===hi1.idx||lo2.idx===lo1.idx)return null;
    const mU=(hi2.price-hi1.price)/(hi2.idx-hi1.idx);
    const bU=hi1.price-mU*hi1.idx;
    const mL=(lo2.price-lo1.price)/(lo2.idx-lo1.idx);
    const bL=lo1.price-mL*lo1.idx;
    const lastIdx=slc.length-1;
    const cur=slc[lastIdx].close;
    const upperNow=mU*lastIdx+bU;
    const lowerNow=mL*lastIdx+bL;
    const converging=mU<mL; // 상단 기울기 < 하단 기울기 = 간격 좁아짐
    let apexPrice=null, barsToApex=null;
    if(Math.abs(mU-mL)>1e-12){
        const apexIdx=(bL-bU)/(mU-mL);
        apexPrice=mU*apexIdx+bU;
        barsToApex=Math.round(apexIdx-lastIdx);
    }
    const midNow=(upperNow+lowerNow)/2; // 중앙선 = 중간값(되돌림 타겟 가설)
    let breakout=null;
    if(cur>upperNow*1.001)breakout='up';
    else if(cur<lowerNow*0.999)breakout='down';
    let type='대칭수렴';
    const aU=Math.abs(mU), aL=Math.abs(mL);
    if(aU<aL*0.35)type='상승수렴';
    else if(aL<aU*0.35)type='하강수렴';
    return {converging,type,apexPrice,barsToApex,midNow,upperNow,lowerNow,cur,breakout};
}
/* ═══════════════════════════════════
   통합 펀딩비 (Binance / Bybit / OKX, OI 가중)
   ═══════════════════════════════════ */
async function updateFundingAggregated(){
    if(isStock(currentSymbol))return;
    const el=document.getElementById('fundingAggContent');
    const valEl=document.getElementById('fundingAggValue');
    if(!el)return;
    const sym=currentSymbol;
    const coin=sym.replace('USDT','');
    const okxInst=coin+'-USDT-SWAP';
    try{
        const [bnF,bnOI,bbT,okF,okOI]=await Promise.all([
            fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${sym}`).then(r=>r.ok?r.json():null).catch(()=>null),
            fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${sym}`).then(r=>r.ok?r.json():null).catch(()=>null),
            bybitTickers(sym).catch(()=>null),
            fetch(`https://www.okx.com/api/v5/public/funding-rate?instId=${okxInst}`).then(r=>r.ok?r.json():null).catch(()=>null),
            fetch(`https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=${okxInst}`).then(r=>r.ok?r.json():null).catch(()=>null),
        ]);
        const rows=[];
        if(bnF&&bnF.lastFundingRate!=null){
            rows.push({ex:'Binance',rate:parseFloat(bnF.lastFundingRate)*100,
                oi:bnOI&&bnOI.openInterest?parseFloat(bnOI.openInterest):0});
        }
        if(bbT&&bbT.fundingRate!=null&&bbT.fundingRate!==''){
            rows.push({ex:'Bybit',rate:parseFloat(bbT.fundingRate)*100,oi:parseFloat(bbT.openInterest||0)});
        }
        if(okF&&okF.data&&okF.data[0]&&okF.data[0].fundingRate!==''){
            rows.push({ex:'OKX',rate:parseFloat(okF.data[0].fundingRate)*100,
                oi:(okOI&&okOI.data&&okOI.data[0])?parseFloat(okOI.data[0].oiCcy||0):0});
        }
        if(!rows.length){el.innerHTML='<div style="color:var(--text-secondary);font-size:11px;padding:10px;">펀딩비 데이터 없음 (해당 종목 미지원 거래소)</div>';if(valEl)valEl.innerHTML='';return;}
        // OI 가중 통합 (OI 없으면 단순평균)
        const totOI=rows.reduce((a,b)=>a+(b.oi>0?b.oi:0),0);
        let agg;
        if(totOI>0)agg=rows.reduce((a,b)=>a+b.rate*(b.oi>0?b.oi:0),0)/totOI;
        else agg=rows.reduce((a,b)=>a+b.rate,0)/rows.length;
        const fmtR=v=>(v>=0?'+':'')+v.toFixed(4)+'%';
        const colR=v=>v>=0?'#f0b90b':'#22d3ee';
        // 통합값 헤더
        const annual=agg*1095;
        if(valEl)valEl.innerHTML=`<span style="color:${colR(agg)}">통합 ${fmtR(agg)}</span> <span style="color:var(--text-secondary);font-size:10px;font-weight:400;">(연 ${annual>=0?'+':''}${annual.toFixed(1)}%)</span>`;
        // 컬럼(바) 표시
        const maxAbs=Math.max(...rows.map(r=>Math.abs(r.rate)),Math.abs(agg),0.0001);
        let html='<div style="display:flex;flex-direction:column;gap:7px;">';
        for(const r of rows){
            const w=Math.min(100,Math.abs(r.rate)/maxAbs*100);
            const oiTxt=r.oi>0?`OI ${(r.oi>=1000?(r.oi/1000).toFixed(1)+'K':r.oi.toFixed(1))}`:'OI -';
            html+=`<div style="display:flex;align-items:center;gap:8px;">
                <span style="width:62px;font-weight:600;">${r.ex}</span>
                <div style="flex:1;height:16px;background:rgba(255,255,255,0.04);border-radius:3px;position:relative;">
                    <div style="position:absolute;left:0;top:0;height:100%;width:${w}%;background:${colR(r.rate)};opacity:0.55;border-radius:3px;"></div>
                </div>
                <span style="width:78px;text-align:right;font-weight:700;color:${colR(r.rate)};font-variant-numeric:tabular-nums;">${fmtR(r.rate)}</span>
                <span style="width:72px;text-align:right;font-size:9px;color:var(--text-secondary);">${oiTxt}</span>
            </div>`;
        }
        html+='</div>';
        el.innerHTML=html;
    }catch(e){console.warn('funding-agg',e);}
}

// 통합 펀딩비 추이 히스토그램 (3사 8h 정산 이력 평균)
let _fundingHistChart=null;
async function updateFundingHistory(){
    if(isStock(currentSymbol))return;
    const cv=document.getElementById('fundingHistChart');
    if(!cv||typeof Chart==='undefined')return;
    const sym=currentSymbol;
    const coin=sym.replace('USDT','');
    const okxInst=coin+'-USDT-SWAP';
    try{
        const [bn,bb,ok]=await Promise.all([
            fetch(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&limit=100`).then(r=>r.ok?r.json():null).catch(()=>null),
            fetch(`https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${sym}&limit=100`).then(r=>r.ok?r.json():null).catch(()=>null),
            fetch(`https://www.okx.com/api/v5/public/funding-rate-history?instId=${okxInst}&limit=100`).then(r=>r.ok?r.json():null).catch(()=>null),
        ]);
        const bkt8=t=>Math.floor(t/(8*3600000))*(8*3600000);
        const mapH=(arr,gt,gl)=>{const m={};if(arr)for(const x of arr){const t=gt(x),v=gl(x);if(isFinite(t)&&isFinite(v))m[bkt8(t)]=v;}return m;};
        const bnM=mapH(Array.isArray(bn)?bn:null,x=>parseInt(x.fundingTime),x=>parseFloat(x.fundingRate)*100);
        const bbM=mapH(bb&&bb.result&&bb.result.list,x=>parseInt(x.fundingRateTimestamp),x=>parseFloat(x.fundingRate)*100);
        const okM=mapH(ok&&ok.data,x=>parseInt(x.fundingTime),x=>parseFloat(x.fundingRate)*100);
        const allB=[...new Set([...Object.keys(bnM),...Object.keys(bbM),...Object.keys(okM)].map(Number))].sort((a,b)=>a-b).slice(-60);
        if(!allB.length)return;
        const vals=allB.map(b=>{const v=[bnM[b],bbM[b],okM[b]].filter(x=>isFinite(x));return v.length?v.reduce((a,c)=>a+c,0)/v.length:null;});
        const labels=allB.map(b=>{const d=new Date(b);return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}h`;});
        const colors=vals.map(v=>v==null?'rgba(0,0,0,0)':(v>=0?'rgba(240,185,11,0.75)':'rgba(34,211,238,0.75)'));
        if(_fundingHistChart){try{_fundingHistChart.destroy();}catch(e){}}
        _fundingHistChart=new Chart(cv,{
            type:'bar',
            data:{labels,datasets:[{data:vals,backgroundColor:colors,borderWidth:0,barPercentage:0.95,categoryPercentage:0.96}]},
            options:{
                responsive:true,maintainAspectRatio:false,
                plugins:{legend:{display:false},
                    tooltip:{callbacks:{label:c=>` ${c.parsed.y>=0?'+':''}${c.parsed.y.toFixed(4)}%`}}},
                scales:{
                    x:{ticks:{color:'#8b949e',maxTicksLimit:9,font:{size:9}},grid:{display:false}},
                    y:{ticks:{color:'#8b949e',font:{size:9},callback:v=>(v>=0?'+':'')+v.toFixed(3)+'%'},
                        grid:{color:c=>c.tick.value===0?'rgba(255,255,255,0.25)':'rgba(255,255,255,0.04)'}},
                },
            },
        });
    }catch(e){console.warn('funding-hist',e);}
}

// 임의 심볼로 차트 전환 (드롭다운에 없으면 옵션 추가)
function goToSymbol(sym){
    const sel=document.getElementById('symbolSelect');
    if(!sel)return;
    if(!Array.from(sel.options).some(o=>o.value===sym)){
        const og=sel.querySelector('optgroup[label="코인 선물"]')||sel;
        const opt=document.createElement('option');opt.value=sym;opt.textContent=sym;og.appendChild(opt);
    }
    sel.value=sym;sel.dispatchEvent(new Event('change',{bubbles:true}));
    window.scrollTo({top:0,behavior:'smooth'});
}

/* ═══════════════════════════════════
   스마트머니 다이버전스 스캐너
   가격 하락 + 고래(상위트레이더) 롱 + 개미(전체계정) 숏 = 컨트래리언 반등 가설
   ═══════════════════════════════════ */
let _smScanning=false;
async function scanSmartMoneyDivergence(){
    if(_smScanning)return;
    _smScanning=true;
    const btn=document.getElementById('smScanBtn');
    const el=document.getElementById('smDivContent');
    const prog=document.getElementById('smScanProgress');
    const mode=(document.getElementById('smMode')||{}).value||'long';
    if(btn){btn.disabled=true;btn.textContent='스캔 중...';}
    try{
        const all=await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr').then(r=>r.ok?r.json():null).catch(()=>null);
        if(!all||!Array.isArray(all)){if(el)el.innerHTML='<div style="color:var(--text-secondary);font-size:11px;padding:12px;">티커 조회 실패 (Binance)</div>';return;}
        // 후보 필터: 반등=하락종목(-2%↓), 하락=급등종목(+4%↑)
        const cands=all.filter(x=>{
            if(!x.symbol.endsWith('USDT')||parseFloat(x.quoteVolume)<=3e7)return false;
            const ch=parseFloat(x.priceChangePercent);
            return mode==='short'?ch>4:ch<-2;
        }).sort((a,b)=>mode==='short'
            ?parseFloat(b.priceChangePercent)-parseFloat(a.priceChangePercent)
            :parseFloat(a.priceChangePercent)-parseFloat(b.priceChangePercent))
            .slice(0,55);
        const rows=[];
        for(let i=0;i<cands.length;i+=5){
            const batch=cands.slice(i,i+5);
            const res=await Promise.all(batch.map(async c=>{
                const sym=c.symbol;
                const [tw,rt]=await Promise.all([
                    fetch(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${sym}&period=1h&limit=1`).then(r=>r.ok?r.json():null).catch(()=>null),
                    fetch(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`).then(r=>r.ok?r.json():null).catch(()=>null),
                ]);
                const whale=(tw&&tw[0])?parseFloat(tw[0].longShortRatio):null;
                const retail=(rt&&rt[0])?parseFloat(rt[0].longShortRatio):null;
                return {sym,chg:parseFloat(c.priceChangePercent),vol:parseFloat(c.quoteVolume),whale,retail};
            }));
            rows.push(...res);
            if(prog)prog.textContent=`${Math.min(i+5,cands.length)}/${cands.length}`;
            await new Promise(r=>setTimeout(r,170));
        }
        // 선별: 반등=고래 롱(≥1.1)+개미 숏(≤0.9) / 하락=개미 롱(≥1.1)+고래 숏(≤0.9)
        const setups=rows.filter(r=>{
            if(r.whale==null||r.retail==null)return false;
            return mode==='short'?(r.retail>=1.1&&r.whale<=0.9):(r.whale>=1.1&&r.retail<=0.9);
        });
        setups.forEach(r=>{r.gap=mode==='short'?(r.retail-r.whale):(r.whale-r.retail);r.score=r.gap*10+Math.min(Math.abs(r.chg),25);});
        setups.sort((a,b)=>b.score-a.score);
        if(prog)prog.textContent=`${setups.length}건 발견`;
        if(!setups.length){el.innerHTML=`<div style="color:var(--text-secondary);font-size:11px;padding:12px;text-align:center;">조건 충족 종목 없음 (${mode==='short'?'가격↑+개미 롱+고래 숏':'가격↓+고래 롱+개미 숏'}). 시장 상황에 따라 0건일 수 있습니다.</div>`;return;}
        const top=setups.slice(0,15);
        let html='<table style="width:100%;font-size:11px;border-collapse:collapse;"><thead><tr style="color:var(--text-secondary);font-size:9px;border-bottom:1px solid var(--border);"><th style="text-align:left;padding:4px 8px;">종목</th><th style="text-align:right;padding:4px 8px;">24h</th><th style="text-align:right;padding:4px 8px;">고래 L/S</th><th style="text-align:right;padding:4px 8px;">개미 L/S</th><th style="text-align:right;padding:4px 8px;">갭</th><th style="text-align:right;padding:4px 8px;">거래대금</th></tr></thead><tbody>';
        for(const r of top){
            const gapC=r.gap>=1?'#00d26a':r.gap>=0.5?'#FFD700':'var(--text-primary)';
            const vol=r.vol>=1e9?(r.vol/1e9).toFixed(1)+'B':(r.vol/1e6).toFixed(0)+'M';
            html+=`<tr style="border-bottom:1px solid rgba(255,255,255,0.05);">
                <td style="padding:6px 8px;cursor:pointer;color:#58a6ff;font-weight:600;" onclick="goToSymbol('${r.sym}')">${r.sym.replace('USDT','')}</td>
                <td style="padding:6px 8px;text-align:right;color:${r.chg>=0?'#00d26a':'#ff4757'};font-weight:600;">${r.chg>=0?'+':''}${r.chg.toFixed(1)}%</td>
                <td style="padding:6px 8px;text-align:right;color:#FFD700;">${r.whale.toFixed(2)}</td>
                <td style="padding:6px 8px;text-align:right;color:#22d3ee;">${r.retail.toFixed(2)}</td>
                <td style="padding:6px 8px;text-align:right;color:${gapC};font-weight:700;">+${r.gap.toFixed(2)}</td>
                <td style="padding:6px 8px;text-align:right;color:var(--text-secondary);">${vol}</td>
            </tr>`;
        }
        html+='</tbody></table>';
        html+=`<div style="font-size:9px;color:var(--text-secondary);text-align:right;margin-top:6px;">${cands.length}개 스캔 → ${setups.length}건 선별 · ${new Date().toLocaleTimeString()}</div>`;
        el.innerHTML=html;
    }catch(e){console.warn('sm-scan',e);if(el)el.innerHTML='<div style="color:var(--text-secondary);font-size:11px;padding:12px;">스캔 오류</div>';}
    finally{_smScanning=false;if(btn){btn.disabled=false;btn.textContent='스캔';}}
}

async function updateTriangleConvergence(){
    const el=document.getElementById('triangleContent');
    if(isStock(currentSymbol)){
        if(el)el.innerHTML='<div style="color:var(--text-secondary);font-size:11px;padding:10px;">주식 모드에서는 미지원 (코인 전용)</div>';
        const a=document.getElementById('triangleAlign');if(a)a.innerHTML='';
        return;
    }
    const sym=currentSymbol;
    const TFs=[['4h','240',120],['1h','60',120],['15m','15',120]];
    try{
        const results=[];
        for(const [label,iv,lim] of TFs){
            const d=await bybitKline(sym,iv,lim).catch(()=>null);
            results.push({label,conv:d?detectConvergence(d):null});
        }
        const convCount=results.filter(r=>r.conv&&r.conv.converging&&!r.conv.breakout).length;
        const alignEl=document.getElementById('triangleAlign');
        if(alignEl){
            if(convCount>=2)alignEl.innerHTML=`<span style="color:#FFD700">프랙탈 정렬: ${convCount}/3 TF 동시 수렴</span>`;
            else if(convCount===1)alignEl.innerHTML=`<span style="color:var(--text-secondary)">1/3 TF 수렴</span>`;
            else alignEl.innerHTML=`<span style="color:var(--text-secondary)">수렴 없음</span>`;
        }
        if(!el)return;
        let html='<table style="width:100%;font-size:11px;border-collapse:collapse;"><thead><tr style="color:var(--text-secondary);font-size:9px;border-bottom:1px solid var(--border);"><th style="text-align:left;padding:4px 8px;">TF</th><th style="text-align:left;padding:4px 8px;">상태</th><th style="text-align:right;padding:4px 8px;">중간값(되돌림 타겟)</th><th style="text-align:right;padding:4px 8px;">apex 도달</th></tr></thead><tbody>';
        for(const r of results){
            const c=r.conv;
            let state,stateColor,mid='-',apex='-';
            if(!c){state='데이터 부족';stateColor='var(--text-secondary)';}
            else if(c.breakout==='up'){state='상단 이탈 (↑돌파)';stateColor='#00d26a';}
            else if(c.breakout==='down'){state='하단 이탈 (↓이탈)';stateColor='#FF69B4';}
            else if(c.converging){state=c.type+' 진행중';stateColor='#FFD700';}
            else{state='수렴 아님';stateColor='var(--text-secondary)';}
            if(c){
                mid=fp(c.midNow);
                apex=(c.barsToApex!=null&&c.barsToApex>0)?`${c.barsToApex}봉 후`:(c.barsToApex!=null?'지남':'-');
            }
            html+=`<tr style="border-bottom:1px solid rgba(255,255,255,0.05);"><td style="padding:5px 8px;font-weight:600;">${r.label}</td><td style="padding:5px 8px;color:${stateColor};">${state}</td><td style="padding:5px 8px;text-align:right;font-variant-numeric:tabular-nums;">${mid}</td><td style="padding:5px 8px;text-align:right;color:var(--text-secondary);">${apex}</td></tr>`;
        }
        html+='</tbody></table>';
        el.innerHTML=html;
    }catch(e){console.warn('triangle',e);}
}

/* ───── 초기화 ───── */
(async function(){
    await initTVChart();initRSIChart();initMACDChart();
    await updateTVChart();refreshAll();connectWS();
    // 초기 로드: 컨센서스, 매크로, 온체인, 코인니스 속보
    updateExpertConsensus();updateMacroData();updateOnchainData();updateCoinnessNews();
    // 초기 로드: ETH/BTC 국면 + 삼각수렴 멀티TF (코인만)
    if(!isStock(currentSymbol)){setTimeout(()=>{updateEthBtcRegime();updateTriangleConvergence();updateFundingAggregated();updateFundingHistory();},1500);}
    // 스마트머니 스캐너: 무거우니 12초 뒤 1회 자동 실행 (이후는 버튼)
    if(!isStock(currentSymbol)){setTimeout(()=>{try{scanSmartMoneyDivergence();}catch(e){}},12000);}
    // 초기 로드: MTF + 다중구간/거래소 청산 + 종목 스캐너
    updateMultiTimeframeAnalysis();
    setTimeout(()=>{updateMultiPeriodLiquidation();updateMultiExchangeLiquidation();},800);
    // 종목 스캐너는 5초 후 시작 (다른 초기 로드 부담 줄임)
    setTimeout(()=>scanTopPicks(),5000);
    // 백테스트 결과 표시
    renderBacktestResults();
    refreshInterval=setInterval(()=>{refreshAll();checkAutoTrade();},1000);
})();
