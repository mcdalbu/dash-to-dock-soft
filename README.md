# Dash to Dock Soft

Fork independente baseado no [Dash to Dock](https://github.com/micheleg/dash-to-dock)
v110. O dock usa o mesmo contorno, os mesmos cantos e a mesma sombra externa dos
menus de notificações/calendário e Quick Settings do GNOME Shell.

- **Nome:** Dash to Dock Soft
- **UUID:** `dash-to-dock-soft@local`
- **Schema:** `org.gnome.shell.extensions.dash-to-dock-soft`
- **Versão deste fork:** 20
- **Repositório:** [mcdalbu/dash-to-dock-soft](https://github.com/mcdalbu/dash-to-dock-soft)

Esta versão atualiza o Dash to Dock Soft principal e mantém seu UUID, schema
e caminho de configurações: os valores já salvos continuam disponíveis.
Mantenha apenas uma extensão de dock ativada por vez.
A extensão **Gnome Shell Soft** pode continuar ativa para os menus.

## Visual dos menus do Shell

Em **Preferências → Aparência**, a opção **Contorno e sombra dos menus do Shell**
vem ativada. Lê diretamente o estilo do Quick Settings do tema ativo (com o menu
do relógio como alternativa), incluindo:

- cor e espessura de cada lado do contorno;
- raio de cada canto;
- cor, opacidade, deslocamento, desfoque e expansão da sombra externa.

A cor do fundo tem um controle independente, descrito abaixo.

Acompanha mudanças entre tema claro e escuro e estilos aplicados ao menu por
**Gnome Shell Soft**. Não aplica transparência aos ícones nem os desfoca.
A versão 20 restaura as margens originais do Dash to Dock, também com o visual
dos menus ativado. A margem fixa de 12 pixels usada para a sombra foi removida.
Sombras que ultrapassam a borda do monitor são recortadas pela tela.
Na versão 17, a sombra externa acompanha o dock durante toda a animação de
entrada e saída, em vez de aparecer somente ao atingir a posição final.
O recorte de pintura acompanha a borda do monitor, preservando a sombra fora
da superfície sem ampliar a área de entrada do dock. No estado totalmente
oculto, o recorte elimina também a sombra, inclusive em temas com sombras grandes.
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
real. O controle **Tamanho da sombra externa (%)**, novo na versão 20, ajusta
os deslocamentos, o desfoque e a expansão juntos, de **0% a 200%**. **100%**
preserva as dimensões do tema, valores menores reduzem a sombra e **200%**
duplica seu tamanho. **0%** remove a sombra. O tamanho é independente da cor
e da intensidade. Os dois controles ficam disponíveis com o estilo dos menus ativado.

## Cores dos menus do Shell

Em **Preferências → Aparência**, o toggle **Usar as cores dos menus do Shell**
aplica ao fundo do dock a cor do Quick Settings, com o menu de notificações/calendário
como alternativa. Acompanha o tema claro/escuro e alterações da cor dos menus.
Vem ativado para manter o perfil visual do fork e funciona independentemente do
toggle de contorno e sombra, inclusive com o tema integrado do dock.

A opacidade continua sendo a do dock: a cor dos menus não copia sua transparência.
Enquanto esse toggle está ativo, o controle de cor personalizada fica desabilitado.
Ao desativá-lo, a cor personalizada salva ou a cor padrão do dock volta a ser usada,
sem apagar os ajustes anteriores. Os ícones mantêm suas cores.

## Altura do dock

Em **Preferências → Posição e tamanho**, o controle **Altura do dock (px)**
move o dock verticalmente, de **−256 a +256 pixels lógicos**. Valores positivos
sobem e valores negativos descem; o padrão **0** restaura a posição original
do Dash to Dock, sem a margem adicional das versões anteriores. O deslocamento
pode ultrapassar as bordas do monitor. O tamanho dos ícones e a espessura
do fundo permanecem iguais. O controle funciona também nos docks laterais.

A versão 16 aplica o valor ao posicionamento real do dock, ao blur e à geometria
usada para ocultação e reserva de espaço, sem limitar a posição à tela.
Valores negativos podem levar o dock parcial ou totalmente para fora da borda
inferior. A alteração é aplicada ao vivo; voltar a 0 restaura a posição.

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

Na versão 19, o blur e a proteção de redesenho completo são ocultados quando
o fundo opaco cobre toda a camada, após a transição de cor e nos frames seguintes.
Ícones em hover não reativam um blur já encoberto. Se o blur ainda aparece nos
cantos, ele permanece ativo; voltar à transparência restaura a captura.
O filtro de janelas acompanha mudanças da geometria e da intensidade do blur.
A proteção contra artefatos continua ativa enquanto o blur está visível.
As propriedades do tema são lidas nas mudanças de estilo e reutilizadas nos frames.
Retirar a segunda camada em cantos opacos pode mudar a suavização do contorno.
As otimizações não adicionam timers periódicos; o ganho de GPU depende do cenário
e não foi quantificado.

Quando segue o visual dos menus, o recorte arredondado do blur acompanha o raio
real do fundo, incluindo a escala. O recorte do blur requer GNOME Rounded Blur
ou suporte nativo a `corner-radius`. Sem esse recurso, o blur funciona com cantos
retos, enquanto a superfície continua arredondada. A biblioteca é opcional e não
é incluída no ZIP; consulte o
[guia oficial](https://github.com/aunetx/blur-my-shell/blob/master/scripts/GUIDE.md).

## Instalar

```bash
gnome-extensions install --force dash-to-dock-soft@local_v20.zip
```

Encerre a sessão e entre novamente para carregar a atualização. Depois:

```bash
# Se usar o original, desative também dash-to-dock@micxgx.gmail.com.
gnome-extensions enable dash-to-dock-soft@local
gnome-extensions prefs dash-to-dock-soft@local
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
make zip-file VERSION=20
```

O teste de integração inicia um GNOME Shell 50 headless em D-Bus e diretórios de
dados/configurações privados, sem instalar o fork na sessão de trabalho:

```bash
/usr/bin/python3 tests/shell-menu-headless.py
```

Requer GNOME Shell 50, PyGObject, GdkPixbuf e GJS/GTK/Adwaita. Compara o contorno, a sombra
e os cantos realmente renderizados nos temas claro/escuro, quatro posições,
escala 2×, alteração de estilos com o menu fechado, transparência dinâmica,
ocultação, ativação/desativação e repouso. Também testa os controles GTK novos.
Resultados e capturas em `validation/shell-menu-*`.
Os testes incluem raio nativo nos modos normal, compacto e estendido,
margens originais nas quatro posições e nos modos normal, compacto e estendido,
movimentação vertical sem redimensionar os ícones, tamanho da sombra entre 0% e
200% (incluindo escala 2×) e intensidade da sombra
em 0%, 50%, 100%, 150% e 200% nos dois temas, além dos vínculos dos controles GTK.
Também medem a opacidade durante aberturas
repetidas do Quick Settings e verificam o alinhamento das preferências em janelas reais.
A versão 17 acrescenta comparação de pixels da sombra fora do dock a meio caminho
da animação nos quatro lados, ausência de sombra ao ocultar e acompanhamento
do recorte em cada frame de uma animação real de autohide.
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
[README da versão 15](README-Dash-to-Dock-Soft.md).
Os módulos de blur e recuperação são herdados do Dash to Dock Soft.
O novo módulo `shellMenuStyle.js` adapta as propriedades reais do tema dos menus.
