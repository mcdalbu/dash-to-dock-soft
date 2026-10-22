# Dash to Dock Shell Soft

Fork independente do [Dash to Dock Soft](https://github.com/mcdalbu/dash-to-dock-soft)
v15 (`f2ac417`), baseado no [Dash to Dock](https://github.com/micheleg/dash-to-dock)
v110. O dock usa o mesmo contorno, os mesmos cantos e a mesma sombra externa dos
menus de notificações/calendário e Quick Settings do GNOME Shell.

- **Nome:** Dash to Dock Shell Soft
- **UUID:** `dash-to-dock-shell-soft@local`
- **Schema:** `org.gnome.shell.extensions.dash-to-dock-shell-soft`
- **Versão deste fork:** 4
- **Repositório:** [mcdalbu/dash-to-dock-shell-soft](https://github.com/mcdalbu/dash-to-dock-shell-soft)

O código, UUID e configurações são próprios. Não substitui a instalação do
Dash to Dock Soft e não copia suas configurações automaticamente. Como todos
controlam o dash do Shell, mantenha apenas uma extensão de dock ativada por vez.
A extensão **Gnome Shell Soft** pode continuar ativa para os menus.

## Visual dos menus do Shell

Em **Preferências → Aparência**, a opção **Contorno e sombra dos menus do Shell**
vem ativada. Lê diretamente o estilo do Quick Settings do tema ativo (com o menu
do relógio como alternativa), incluindo:

- cor e espessura de cada lado do contorno;
- raio de cada canto;
- cor, opacidade, deslocamento, desfoque e expansão da sombra externa;
- cor do fundo, preservando a opacidade escolhida para o dock.

Acompanha mudanças entre tema claro e escuro e estilos aplicados ao menu por
**Gnome Shell Soft**. Não aplica transparência aos ícones nem os desfoca.
O dock flutuante deixa 12 pixels lógicos até a borda da tela para a sombra.
Quando está totalmente visível, seu recorte permite a pintura externa; durante
ocultação e animações de deslizamento, o recorte continua protegendo a área oculta.
O modo estendido mantém seu posicionamento junto à borda da tela.

Os controles manuais de contorno e raio ficam desabilitados enquanto o estilo
dos menus é seguido. Desligue essa opção para voltar a ajustá-los separadamente.
Os valores manuais permanecem salvos.

A opção **Manter o raio padrão dos cantos do Dash to Dock** permite conservar
os cantos do dock e usar somente o contorno e a sombra dos menus. O raio continua
acompanhando os modos compacto e estendido, e o recorte do blur usa o mesmo raio
do fundo. Essa opção vem desativada, preservando o visual dos menus por padrão.

O controle **Intensidade da sombra externa (%)** vai de **0% a 200%** e afeta
apenas a opacidade da sombra externa. O padrão **100%** usa exatamente a sombra
do Quick Settings, incluindo a diferença entre os temas claro e escuro. **0%**
remove a sombra; **200%** duplica sua opacidade, limitada a 100% de opacidade
real. A cor, os deslocamentos e o desfoque permanecem os do tema. Esse controle
fica disponível com o estilo dos menus ativado.

## Altura do dock

Em **Preferências → Posição e tamanho**, o controle **Altura do dock (px)**
move o dock verticalmente, de **−256 a +256 pixels lógicos**. Valores positivos
sobem e valores negativos descem; **0** restaura a posição original. O deslocamento
pode ultrapassar as bordas do monitor. O tamanho dos ícones e a espessura
do fundo permanecem iguais. O controle funciona também nos docks laterais.

Na versão 2 esse controle alterava a espessura do fundo. A versão 3 corrige seu
significado e aplica o valor ao posicionamento real do dock, ao blur e à geometria
usada para ocultação e reserva de espaço. A versão 4 remove o limite da tela,
permitindo que valores negativos levem o dock parcial ou totalmente para fora
da borda inferior. A alteração é aplicada ao vivo; voltar a 0 restaura a posição.

## Estabilidade e organização das preferências

Abrir e fechar o Quick Settings não reaplica o tema do dock quando as cores,
o contorno, os cantos e a sombra do menu continuam iguais. Eventos de estilo são
agrupados e comparados depois de o estilo final estar disponível. A opacidade do
menu é independente da opacidade do dock. Isso evita reiniciar a transição de
transparência ao abrir o menu, inclusive com Gnome Shell Soft ativo.

As páginas de preferências usam margens e espaçamento consistentes, rótulos à
esquerda, controles alinhados e colunas compartilhadas por página. Foram corrigidos
os controles de tamanho do dock e de prévia que ocupavam a célula de seus rótulos.
As opções novas de altura e sombra seguem o mesmo layout das outras escalas.

## Blur e transparência

O blur dinâmico herdado do Dash to Dock Soft vem **ativado**, com intensidade
**30**, opacidade fixa do fundo em **55%** e brilho de **85%**. Usa uma camada
separada com `BlurEffect` em modo `BACKGROUND`, preservando os ícones nítidos.
A transparência dinâmica e os demais ajustes herdados continuam disponíveis.

Quando segue o visual dos menus, o recorte arredondado do blur acompanha o raio
real do fundo, incluindo a escala. O recorte do blur requer GNOME Rounded Blur
ou suporte nativo a `corner-radius`. Sem esse recurso, o blur funciona com cantos
retos, enquanto a superfície continua arredondada. A biblioteca é opcional e não
é incluída no ZIP; consulte o
[guia oficial](https://github.com/aunetx/blur-my-shell/blob/master/scripts/GUIDE.md).

## Instalar

```bash
gnome-extensions install dash-to-dock-shell-soft@local_v4.zip
```

Encerre a sessão e entre novamente para reconhecer uma extensão nova. Depois:

```bash
gnome-extensions disable dash-to-dock-soft@local
# Se usar o original, desative também dash-to-dock@micxgx.gmail.com.
gnome-extensions enable dash-to-dock-shell-soft@local
gnome-extensions prefs dash-to-dock-shell-soft@local
```

Ignore a desativação de uma extensão que não estiver instalada. Para atualizar
este fork, instale o ZIP com `gnome-extensions install --force`.

## Compilar e validar

Dependências: `make`, `glib-compile-schemas`, `sassc`, `gettext`, `python3` e `zip`.
Para lint, use ESLint 8; os testes de regressão usam Node.js.

```bash
make
make check
node tests/dock-effects.cjs
node tests/dock-redraw-recovery.cjs
make zip-file VERSION=4
```

O teste de integração inicia um GNOME Shell 50 headless em D-Bus e diretórios de
dados/configurações privados, sem instalar o fork na sessão de trabalho:

```bash
/usr/bin/python3 tests/shell-menu-headless.py
```

Requer GNOME Shell 50, PyGObject e GJS/GTK/Adwaita. Compara o contorno, a sombra
e os cantos realmente renderizados nos temas claro/escuro, quatro posições,
escala 2×, alteração de estilos com o menu fechado, transparência dinâmica,
ocultação, ativação/desativação e repouso. Também testa os controles GTK novos.
Resultados e capturas em `validation/shell-menu-*`.
Os testes incluem raio nativo nos modos normal, compacto e estendido,
movimentação vertical sem redimensionar os ícones e intensidade da sombra
em 0%, 50%, 100%, 150% e 200% nos dois temas, além dos vínculos dos controles GTK.
Também medem a opacidade durante aberturas
repetidas do Quick Settings e verificam o alinhamento das preferências em janelas reais.
Para testar em conjunto com Gnome Shell Soft:

```bash
SOFT_TEST_WITH_SHELL_SOFT=1 /usr/bin/python3 tests/shell-menu-headless.py
```

Compatibilidade declarada **45–51**, herdada da base. A validação de integração
usa **GNOME Shell 50.6**; as outras versões e a suspensão física precisam de
verificação nas respectivas sessões. O teste não comprova esses cenários.

## Créditos

Mantém o histórico, as funcionalidades e a licença GPL-2.0-or-later do
Dash to Dock e do Dash to Dock Soft. Veja `COPYING`, `AUTHORS.md` e o
[README da base](README-Dash-to-Dock-Soft.md).
Os módulos de blur e recuperação são herdados do Dash to Dock Soft.
O novo módulo `shellMenuStyle.js` adapta as propriedades reais do tema dos menus.
