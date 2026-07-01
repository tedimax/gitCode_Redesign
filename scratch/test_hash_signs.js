function hashFunction(string) {
  let hashKey = 0;
  for (let i = 0; i < string.length; i++) {
    const chr = string.charCodeAt(i);
    hashKey = ((hashKey << 5) - hashKey) + chr;
    hashKey |= 0;
  }
  return hashKey.toString();
}

console.log("Broad DJB2 Hashing Sandbox");

const dates = [
  "Fri May 22 2026 00:00:00 GMT+0100 (British Summer Time)",
  "Fri May 22 2026 00:00:00 GMT+0100 (BST)",
  "Fri May 22 2026 01:00:00 GMT+0100 (British Summer Time)",
  "Fri May 22 2026 01:00:00 GMT+0100 (BST)",
  "2026-05-22",
  "2026-05-22T00:00:00",
  "2026-05-22 00:00:00",
  "22/05/2026",
  "22/05/26",
  "22-05-2026"
];

// Let's test different possible fields that could be in a bank transaction
// Typical bank csv columns: Date, Type, Description, Value/Amount, Balance etc.
// Let's assume some descriptions
const descriptions = [
  "",
  "PAYMENT",
  "Withdrawal",
  "INTEREST",
  "DIRECT DEBIT",
  "TRANSFER"
];

// Let's try some typical amounts
const amounts = [
  "-15.00", "15.00", "-15", "15",
  "-50.00", "50.00", "-50", "50",
  "-100.00", "100.00", "-100", "100",
  "-20.00", "20.00", "-20", "20",
  "-17.50", "17.50", "-17.5", "17.5"
];

dates.forEach(d => {
  amounts.forEach(a => {
    descriptions.forEach(desc => {
      // Try hashing just (d, a)
      const s1 = d + a + "0";
      const h1 = hashFunction(s1);
      if (h1.includes("1773548723") || h1.includes("762024926")) {
        console.log(`FOUND MATCH 2-args: d='${d}', a='${a}', hash=${h1}`);
      }
      
      // Try hashing (d, desc, a) or (d, a, desc)
      const s2 = d + desc + a + "0";
      const h2 = hashFunction(s2);
      if (h2.includes("1773548723") || h2.includes("762024926")) {
        console.log(`FOUND MATCH 3-args: d='${d}', desc='${desc}', a='${a}', hash=${h2}`);
      }
      
      const s3 = d + a + desc + "0";
      const h3 = hashFunction(s3);
      if (h3.includes("1773548723") || h3.includes("762024926")) {
        console.log(`FOUND MATCH 3-args: d='${d}', a='${a}', desc='${desc}', hash=${h3}`);
      }
    });
  });
});
