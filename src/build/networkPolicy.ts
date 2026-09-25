/** Default editions authorize only the model endpoint. */
export const additionalPolicy: ((endpoint: URL, target: URL) => Promise<void>) | undefined = undefined;
