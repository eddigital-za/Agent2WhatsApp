'use strict';
// Shared, local-only address interpretation. Customer street addresses never
// become geocoding queries. Explicit city components outrank suburb aliases.
const aliases=[['Herolds Bay',/herold.?s? bay/i],['Paarl',/paarl|pearl valley/i],['Suurbraak',/suurbraak|stuurbraak|stuurbrak|swellendam/i],['Dundee',/dundee/i],['Pietermaritzburg',/\b(pmb|pietermaritzburg)\b/i],['Durban',/\b(dbn|durban|ballito|woodhaven|queensburgh|pinetown|umlazi)\b/i],['Johannesburg',/\b(jhb|joburg|johannesburg|pta|pretoria|montana|sandton|midrand|rosebank|pomona|kempton|randburg|edenvale|fourways|centurion|roodepoort|roodeport)\b/i],['Cape Town',/\b(cpt|cape town|hout bay|rondebosch|milnerton|stellenbosch|somerset west)\b/i],['Gqeberha',/\b(pe|gqeberha|port elizabeth|st\.? francis)\b/i],['East London',/\b(el|east london)\b/i],['Bloemfontein',/bloem|pellissier/i]];
const cities=['Durban','Johannesburg','Cape Town','Malelane','Hoedspruit','Herolds Bay','Dundee','Pietermaritzburg','Paarl','Suurbraak','George','Bloemfontein','Gqeberha','East London'];
const clean=value=>String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim();
const province=/^(?:south africa|za|kzn|kwazulu[ -]?natal|gauteng|western cape|eastern cape|free state|limpopo|mpumalanga|north west|northern cape)(?:\s+\d{4})?$/i;
function locality(value){
 const text=clean(value).replace(/\s+\d{4}$/, '');
 if(!text||province.test(text)||/^(?:not specified|unspecified)$/i.test(text)||/\bst\.?$/i.test(text)||/\d|\b(?:road|rd|street|avenue|ave|drive|dr|close|crescent|unit|plot|depot|depo|building|floor|phone|contact|unknown|tbc|tbd)\b/i.test(text))return '';
 return /^[\p{L} .'-]{2,70}$/u.test(text)?text:'';
}
function town(value,address){
 const parts=String(address||'').split(/[,;\n]+/).map(locality).filter(Boolean);
 // A city named as a complete postal component is stronger evidence than
 // e.g. Rosebank, which exists in more than one city.
 const explicit=parts.map(p=>cities.find(c=>c.toLowerCase()===p.toLowerCase())).filter(Boolean);
 if(new Set(explicit).size===1)return explicit[0];
 if(new Set(explicit).size>1)return ''; // conflicting address needs review
 for(const part of parts.reverse()){
  const hit=aliases.find(([,re])=>re.test(part));if(hit)return hit[0];
 }
 const text=locality(value);if(!text)return '';
 return aliases.find(([,re])=>re.test(text))?.[0]||cities.find(c=>c.toLowerCase()===text.toLowerCase())||text;
}
function region(value,address){
 const place=town(value,address);
 return ({Paarl:'Cape Town',Pietermaritzburg:'Durban','Herolds Bay':'George',Suurbraak:'George'})[place]||place;
}
module.exports={town,region,locality};
