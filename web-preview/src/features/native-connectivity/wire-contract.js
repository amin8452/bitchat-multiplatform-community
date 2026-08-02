import contract from "../../../../protocol-conformance/bitchat-wire-v1.json" with { type: "json" };

export const BitChatWireContract = Object.freeze({
  ...contract,
  bluetooth: Object.freeze({ ...contract.bluetooth }),
  messageTypes: Object.freeze({ ...contract.messageTypes }),
  noise: Object.freeze({
    ...contract.noise,
    payloadTypes: Object.freeze({ ...contract.noise.payloadTypes }),
    decodeAliases: Object.freeze({ ...contract.noise.decodeAliases })
  }),
  fileTransfer: Object.freeze({ ...contract.fileTransfer }),
  nostr: Object.freeze({ ...contract.nostr })
});
