const pkRegex = /^[A-Za-z0-9.-]+#(20\d{2}|20\d{6})(\.\d{2,5})?_[A-Za-z0-9.#-]+$/;

const testKeys = [
  "Bank#20210216.000_932893600",    // Old key format (3 digits)
  "Bank#20210216.1000_-932893600",  // New key format (4 digits)
  "Bank#20210216.10000_932893600"   // New key format (5 digits)
];

testKeys.forEach(key => {
  const result = pkRegex.test(key);
  console.log(`Key: "${key}" -> Match: ${result}`);
});
