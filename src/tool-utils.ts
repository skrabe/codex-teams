export function toolError(msg: string) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: msg }],
  };
}

export function toolSuccess(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

export function toolJson(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}
