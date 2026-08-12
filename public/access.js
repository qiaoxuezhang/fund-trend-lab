const form = document.querySelector("#accessForm");
const password = document.querySelector("#accessPassword");
const status = document.querySelector("#accessStatus");
const toggle = document.querySelector("#togglePassword");

toggle.addEventListener("click", () => {
  const visible = password.type === "text";
  password.type = visible ? "password" : "text";
  toggle.textContent = visible ? "显示" : "隐藏";
  password.focus();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector("button[type='submit']");
  submit.disabled = true;
  status.textContent = "正在验证访问权限";
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: password.value })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "验证失败");
    window.location.replace("/");
  } catch (error) {
    status.textContent = error.message;
    password.select();
  } finally {
    submit.disabled = false;
  }
});
