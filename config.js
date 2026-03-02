window.ZakovatAppConfig = {
  // "local" faqat bir brauzer ichida ishlaydi.
  // "cloud" turli brauzer/qurilmalar o'rtasida ishlaydi.
  syncMode: "cloud",

  // Barcha qurilmalarda bir xil roomId bo'lishi kerak.
  roomId: "main",

  // Firebase Realtime Database URL manzili.
  // Masalan: https://my-project-default-rtdb.firebaseio.com
  firebaseDatabaseUrl: "",

  // Agar DB rules auth talab qilsa token kiriting, bo'lmasa bo'sh qoldiring.
  firebaseAuthToken: "",

  // Cloud polling interval (ms).
  pollMs: 500
};
