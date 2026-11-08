const {createAlbumCollector}=require("./orders-photo-album");

const assert=require("node:assert/strict");
(async()=>{
 const sent=[];const c=createAlbumCollector({send:async p=>sent.push(p),legacy:async()=>{},timeout:20});
 const child=(id,text,mediaData)=>({messageId:id,text,mediaData,mediaType:"image/jpeg",quotedText:text?"New Order - DBN to JHB - R2500\\nMake and Model: Honda CBR":"",author:"operator",from:"orders"});
 c.accept({author:"operator"},{parentId:"A",isParent:true,count:5});
 for(let i=0;i<4;i++)c.accept(child("i"+i,i===0?"Collected":"","data"+i),{parentId:"A"});
 assert.equal(sent.length,0);
 c.accept(child("i4","","data4"),{parentId:"A"});
 assert.equal(sent.length,1);assert.equal(sent[0].albumPhotos.length,5);
 c.accept(child("i4","","data4"),{parentId:"A"});assert.equal(sent.length,1);
 c.accept({author:"operator"},{parentId:"B",isParent:true,count:2});
 c.accept(child("j0","Delivered","data"),{parentId:"B"});c.accept(child("j1","",null),{parentId:"B"});
 assert.ok(sent[1].albumError);assert.equal(sent[1].albumPhotos,undefined);
 console.log("PASS: five-photo album, replay deduplication and incomplete album held");
})().catch(e=>{console.error(e);process.exitCode=1});
