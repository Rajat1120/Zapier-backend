export function parse(
  text: string = "",
  values: any = {},
  startDelimeter = "{",
  endDelimeter = "}"
) {
  if (typeof text !== "string") return "";

  let startIndex = 0;
  let endIndex = 1;
  let finalString = "";

  while (endIndex < text.length) {
    if (text[startIndex] === startDelimeter) {
      let endPoint = startIndex + 1;

      // Safely find end delimiter
      while (text[endPoint] !== endDelimeter && endPoint < text.length) {
        endPoint++;
      }

      // If we reach the end without finding the end delimiter, treat it as normal text
      if (text[endPoint] !== endDelimeter) {
        finalString += text[startIndex];
        startIndex++;
        endIndex++;
        continue;
      }

      const placeholder = text.slice(startIndex + 1, endPoint).trim(); // e.g. comment.amount
      const keys = placeholder.split(".");

      let localValues =
        typeof values === "string" ? JSON.parse(values) : { ...values };
      let resolvedValue: any = localValues;

      for (const key of keys) {
        if (
          resolvedValue &&
          typeof resolvedValue === "object" &&
          key in resolvedValue
        ) {
          resolvedValue = resolvedValue[key];
        } else {
          resolvedValue = ""; // fallback if key doesn't exist
          break;
        }
      }

      finalString += resolvedValue;
      startIndex = endPoint + 1;
      endIndex = startIndex + 1;
    } else {
      finalString += text[startIndex];
      startIndex++;
      endIndex++;
    }
  }

  // Add any leftover character
  if (text[startIndex]) {
    finalString += text[startIndex];
  }

  return finalString;
}
