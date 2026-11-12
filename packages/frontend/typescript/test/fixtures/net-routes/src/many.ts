// A wrapper with 101 call sites (over the cap, none resolved) and one with 2 (all resolved).
export async function many(url: string) {
  return fetch(url);
}

export async function few(url: string) {
  return fetch(url, { method: "PUT" });
}

export async function manyCallers() {
  await many("/api/n0");
  await many("/api/n1");
  await many("/api/n2");
  await many("/api/n3");
  await many("/api/n4");
  await many("/api/n5");
  await many("/api/n6");
  await many("/api/n7");
  await many("/api/n8");
  await many("/api/n9");
  await many("/api/n10");
  await many("/api/n11");
  await many("/api/n12");
  await many("/api/n13");
  await many("/api/n14");
  await many("/api/n15");
  await many("/api/n16");
  await many("/api/n17");
  await many("/api/n18");
  await many("/api/n19");
  await many("/api/n20");
  await many("/api/n21");
  await many("/api/n22");
  await many("/api/n23");
  await many("/api/n24");
  await many("/api/n25");
  await many("/api/n26");
  await many("/api/n27");
  await many("/api/n28");
  await many("/api/n29");
  await many("/api/n30");
  await many("/api/n31");
  await many("/api/n32");
  await many("/api/n33");
  await many("/api/n34");
  await many("/api/n35");
  await many("/api/n36");
  await many("/api/n37");
  await many("/api/n38");
  await many("/api/n39");
  await many("/api/n40");
  await many("/api/n41");
  await many("/api/n42");
  await many("/api/n43");
  await many("/api/n44");
  await many("/api/n45");
  await many("/api/n46");
  await many("/api/n47");
  await many("/api/n48");
  await many("/api/n49");
  await many("/api/n50");
  await many("/api/n51");
  await many("/api/n52");
  await many("/api/n53");
  await many("/api/n54");
  await many("/api/n55");
  await many("/api/n56");
  await many("/api/n57");
  await many("/api/n58");
  await many("/api/n59");
  await many("/api/n60");
  await many("/api/n61");
  await many("/api/n62");
  await many("/api/n63");
  await many("/api/n64");
  await many("/api/n65");
  await many("/api/n66");
  await many("/api/n67");
  await many("/api/n68");
  await many("/api/n69");
  await many("/api/n70");
  await many("/api/n71");
  await many("/api/n72");
  await many("/api/n73");
  await many("/api/n74");
  await many("/api/n75");
  await many("/api/n76");
  await many("/api/n77");
  await many("/api/n78");
  await many("/api/n79");
  await many("/api/n80");
  await many("/api/n81");
  await many("/api/n82");
  await many("/api/n83");
  await many("/api/n84");
  await many("/api/n85");
  await many("/api/n86");
  await many("/api/n87");
  await many("/api/n88");
  await many("/api/n89");
  await many("/api/n90");
  await many("/api/n91");
  await many("/api/n92");
  await many("/api/n93");
  await many("/api/n94");
  await many("/api/n95");
  await many("/api/n96");
  await many("/api/n97");
  await many("/api/n98");
  await many("/api/n99");
  await many("/api/n100");
}

export async function fewCallers() {
  await few("/api/a");
  await few("/api/b");
}
