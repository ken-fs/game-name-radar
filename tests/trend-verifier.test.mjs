import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateTrendVerdict, parseSerpApiTimeline, steadyRising } from '../lib/trend-verifier.mjs';

test('parses SerpApi interest-over-time values',()=>{
  const payload={interest_over_time:{timeline_data:[
    {values:[{extracted_value:12},{value:'7'},{value:'<1'}]},
    {values:[{value:'18'},{extracted_value:9},{extracted_value:30}]},
  ]}};
  assert.deepEqual(parseSerpApiTimeline(payload,0),[12,18]);
  assert.deepEqual(parseSerpApiTimeline(payload,1),[7,9]);
  assert.deepEqual(parseSerpApiTimeline(payload,2),[1,30]);
});

test('steadyRising is an additive signal for weekly and daily curves',()=>{
  const weeks=[4,4,4,4,4,6,9,14];
  assert.equal(steadyRising(weeks).match,true);
  assert.equal(steadyRising([4,4,4,4,4,6,9,12]).match,false);
  const daily=weeks.flatMap((value)=>Array(7).fill(value)).concat([99]);
  assert.equal(steadyRising(daily,{daily:true}).match,true);
  assert.equal(steadyRising([0,0,0,0,0,1,2,3]).match,true); // 观察层允许从零起量，不设绝对量下限
});

test('rejects all-zero trend demand',()=>{
  const verdict=calculateTrendVerdict({
    gameName:'Quiet Hallways',
    sevenDayCandidate:Array(20).fill(0),sevenDayAnchor:Array(20).fill(40),
    thirtyDayCandidate:Array(30).fill(0),thirtyDayAnchor:Array(30).fill(35),
  });
  assert.equal(verdict.classification,'none');
  assert.equal(verdict.score,0);
});

test('recognizes strong demand against anchor',()=>{
  const verdict=calculateTrendVerdict({
    gameName:'Quiet Hallways',
    sevenDayCandidate:[8,10,12,16,18,20,24,28],sevenDayAnchor:[40,40,42,43,44,42,41,40],
    thirtyDayCandidate:Array.from({length:30},(_,i)=>8+Math.floor(i/5)),
    thirtyDayAnchor:Array(30).fill(40),
  });
  assert.ok(['strong','rising','breakout'].includes(verdict.classification));
  assert.ok(verdict.score>=40);
});

test('recognizes clear 7-day breakout',()=>{
  const verdict=calculateTrendVerdict({
    gameName:'Sudden New Horror',
    sevenDayCandidate:[0,0,1,1,5,12,18,24],sevenDayAnchor:Array(8).fill(45),
    thirtyDayCandidate:[...Array(22).fill(0),1,1,2,4,7,10,13,16],thirtyDayAnchor:Array(30).fill(45),
    ninetyDayCandidate:[...Array(60).fill(0),...Array(22).fill(0),1,1,2,4,7,10,13,16],
    ninetyDayAnchor:Array(90).fill(45),
  });
  assert.ok(['breakout','rising'].includes(verdict.classification));
  assert.equal(verdict.rising7||verdict.breakout7,true);
  assert.equal(verdict.keywordFreshness,'new');
});

test('recognizes clear 30-day rise even when 7-day ratio is moderate',()=>{
  const candidate=[...Array(16).fill(1),2,2,3,3,4,5,6,7,8,9,10,12,14,16];
  const verdict=calculateTrendVerdict({
    gameName:'Slow Burn Game',
    sevenDayCandidate:candidate.slice(-8),sevenDayAnchor:Array(8).fill(55),
    thirtyDayCandidate:candidate,thirtyDayAnchor:Array(30).fill(55),
  });
  assert.ok(['breakout','rising','strong'].includes(verdict.classification));
  assert.equal(verdict.rising30||verdict.breakout30,true);
});

test('keeps isolated one-day spike weak',()=>{
  const seven=[0,0,0,0,0,40,0,0];
  const thirty=[...Array(22).fill(0),0,0,50,0,0,0,0,0];
  const verdict=calculateTrendVerdict({
    gameName:'One Day Spike',
    sevenDayCandidate:seven,sevenDayAnchor:Array(8).fill(45),
    thirtyDayCandidate:thirty,thirtyDayAnchor:Array(30).fill(45),
  });
  assert.equal(verdict.classification,'weak');
});

test('keeps sparse low-volume term weak',()=>{
  const candidate=[0,0,0,1,0,0,0,0,1,0,0,0];
  const anchor=Array(candidate.length).fill(45);
  const verdict=calculateTrendVerdict({
    gameName:'Tiny Unknown Game',
    sevenDayCandidate:candidate,sevenDayAnchor:anchor,
    thirtyDayCandidate:[...candidate,...Array(18).fill(0)],thirtyDayAnchor:Array(30).fill(45),
  });
  assert.equal(verdict.classification,'weak');
});

test('marks a long-running ambiguous phrase as an existing keyword',()=>{
  const exact90=Array.from({length:90},(_,i)=>70-Math.floor(i/4));
  const qualified90=Array(90).fill(0).map((_,i)=>i>80?1:0);
  const exact30=exact90.slice(-30);
  const qualified30=qualified90.slice(-30);
  const verdict=calculateTrendVerdict({
    gameName:'Up Hero',
    sevenDayCandidate:exact30.slice(-8),
    sevenDayQualified:qualified30.slice(-8),
    sevenDayAnchor:Array(8).fill(45),
    thirtyDayCandidate:exact30,
    thirtyDayQualified:qualified30,
    thirtyDayAnchor:Array(30).fill(45),
    ninetyDayCandidate:exact90,
    ninetyDayQualified:qualified90,
    ninetyDayAnchor:Array(90).fill(45),
  });
  assert.equal(verdict.keywordFreshness,'existing');
  assert.equal(verdict.entityConflict,true);
  assert.equal(verdict.rising7,false);
  assert.equal(verdict.rising30,false);
});

test('can detect growth in the game-qualified query separately',()=>{
  const exact90=Array(90).fill(25);
  const qualified90=[...Array(60).fill(0),...Array.from({length:30},(_,i)=>Math.floor(i/3))];
  const exact30=exact90.slice(-30);
  const qualified30=qualified90.slice(-30);
  const verdict=calculateTrendVerdict({
    gameName:'Shared Phrase',
    sevenDayCandidate:exact30.slice(-8),
    sevenDayQualified:qualified30.slice(-8),
    sevenDayAnchor:Array(8).fill(45),
    thirtyDayCandidate:exact30,
    thirtyDayQualified:qualified30,
    thirtyDayAnchor:Array(30).fill(45),
    ninetyDayCandidate:exact90,
    ninetyDayQualified:qualified90,
    ninetyDayAnchor:Array(90).fill(45),
  });
  assert.equal(verdict.keywordFreshness,'existing');
  assert.equal(verdict.qualifiedRising30||verdict.breakout30,true);
});
