import { Field } from "academy-design-system";

const inputStyle = {
  width: "100%",
  padding: "0.5rem 0.75rem",
  border: "1px solid #E2E5EA",
  borderRadius: 8,
  fontSize: "0.875rem",
};

export function Default() {
  return (
    <Field label="Email address" htmlFor="ds-preview-email">
      <input id="ds-preview-email" type="email" placeholder="owner@academy.com" style={inputStyle} />
    </Field>
  );
}

export function WithError() {
  return (
    <Field label="Email address" htmlFor="ds-preview-email-error" error="Enter a valid email address">
      <input id="ds-preview-email-error" type="email" defaultValue="not-an-email" style={inputStyle} />
    </Field>
  );
}
