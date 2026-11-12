# Spegne la «Modifica rapida» (QuickEdit) della finestra del motore: con QuickEdit un clic nella finestra la mette in
# selezione («Seleziona» nel titolo) e Windows blocca chi scrive sulla console, cioè il motore e Kronos, finché non si
# preme Esc o Invio. Vale solo per questa finestra (la console condivisa con il motore), non per le altre.
$firma = @'
[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int h);
[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m);
[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);
'@
$k = Add-Type -MemberDefinition $firma -Name ModoConsole -Namespace AgenticsSniper -PassThru
$h = $k::GetStdHandle(-10)
$m = 0
if ($k::GetConsoleMode($h, [ref]$m)) {
  # 0x40 = QuickEdit, 0x80 = flag estesi (serve per renderlo effettivo)
  if ($k::SetConsoleMode($h, (($m -band (-bnot 0x40)) -bor 0x80))) { "Modifica rapida della finestra spenta: un clic non blocca più il motore." }
}
