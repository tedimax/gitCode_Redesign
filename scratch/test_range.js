const ProxyTest = (() => {
  const labels = ["LongName", "SSID", "SheetName", "Key", "Keys", "KeyFields"];
  const column = { longname: 0, ssid: 1, sheetname: 2, key: 3, keys: 4, keyfields: 5 };
  const data = ["ImportsArchive_RawSMPay", "SSID_123", "RawSMPay", "", "KeysCol", "KeyFieldsCol"];

  return {
    getRowObjectByOffset(rowOffset) {
      return new Proxy({ _rowOffset: rowOffset }, {
        get: (target, prop) => {
          if (typeof prop === 'string') {
            const colOff = column[prop.toLowerCase()];
            if (colOff !== undefined) {
              return data[colOff];
            }
          }
          return Reflect.get(target, prop);
        },
        ownKeys: () => {
          return labels;
        },
        getOwnPropertyDescriptor: (target, prop) => {
          return { enumerable: true, configurable: true };
        }
      });
    }
  };
})();

const obj = ProxyTest.getRowObjectByOffset(0);
console.log("Keys using Object.keys:", Object.keys(obj));
console.log("Entries using Object.entries:", Object.entries(obj));
console.log("Spreading:", { ...obj });
