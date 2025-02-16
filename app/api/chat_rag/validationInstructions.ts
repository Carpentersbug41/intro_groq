// ---------------------------------------------------------------------------------
// Define validation instructions (only once)
// ---------------------------------------------------------------------------------
export const defaultValidationInstruction = `
  You are a validation assistant.
  Your task is to assess if the user's input answers the question.

  if the user chooses an option, it is VALID. If user choose an option, it is INVALID.
  Current prompt: '{CURRENT_PROMPT}'
  User input: '{USER_INPUT}'

  Respond with only one word: "VALID" if the user chooses an option,
  or "INVALID" if the user doesn't choose an option.
  Do not provide any additional explanation or description.
`;

export const customValidationInstructionForList = `
  You are a validation assistant.
  Your task is to assess if the user has answered 'red'. 
  As long as the user has answered 'red', it is VALID. 
  If not, it is INVALID.
  Current prompt: '{CURRENT_PROMPT}'
  User input: '{USER_INPUT}'

  Respond with only one word: "VALID" if the user has answered 'red',
  or "INVALID" if they have not.
  Do not provide any additional explanation or description.
`;

export const customValidationInstructionForQuestion = `
  You are a validation assistant.
  Your task is to assess if the user is happy with their essay question. 
  As long as the user has answered 'yes' or wants the question they have been given, it is VALID. 
  If the user wants another question, it is INVALID.
  Current prompt: '{CURRENT_PROMPT}'
  User input: '{USER_INPUT}'

  Respond with only one word: "VALID" if the user has answered 'yes' or 'ok',
  or "INVALID" if they have not.
  Do not provide any additional explanation or description.
`;
