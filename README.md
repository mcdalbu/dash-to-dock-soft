# Dash to Dock Soft

Fork independente do [Dash to Dock](https://github.com/micheleg/dash-to-dock),
de Michele G. e colaboradores, mantido por [mcdalbu](https://github.com/mcdalbu).
Não é uma versão oficial do projeto original.
Base: commit `8c2cb998972a72c5c459dc07a8c2067bf654779e` (versão upstream 109).

## Novas opções

Em **Preferências → Aparência**:

- **Sombra suave nos ícones**: sombra preta com intensidade ajustável de 0% a 100%
  (padrão 24%), deslocamento vertical de 2 px e desfoque de 4 px, aplicada ao
  desenho dos ícones. O deslocamento horizontal e o vertical são ajustáveis de
  −32 a 32 px (padrões: 0 e 2 px); o desfoque varia de 0 a 32 px (padrão: 4 px).
  Os controles ficam disponíveis ao ativar a sombra. Os valores são em pixels
  lógicos e acompanham a escala do monitor.
- **Contorno do dock inspirado no Adwaita**: borda de 1 px ao redor do fundo
  do dock, acompanhando o raio dos cantos definido pelo tema. Usa branco em
  fundos escuros e preto em fundos claros, com intensidade ajustável de 0% a
  100% (padrão 15%). O slider fica disponível ao ativar o contorno.
- **Desfoque atrás do dock**: blur dinâmico nativo do GNOME Shell, aplicado
  em uma camada separada atrás do dock. Os ícones continuam nítidos. Há um controle de
  intensidade de 1 a 100, com padrão 30, ajustado à escala do monitor. O raio
  dos cantos também é ajustável de 0 a 100 px (padrão 24 px), na mesma escala.

As três opções são independentes, desativadas por padrão e atualizadas ao vivo.
A sombra inclui o botão Mostrar aplicativos; o contorno envolve o dock inteiro.
As traduções estão disponíveis em português e português brasileiro.

O blur usa `Shell.BlurEffect` em modo `BACKGROUND`, como o blur dinâmico do
[Blur my Shell](https://github.com/aunetx/blur-my-shell). É uma implementação
própria integrada ao fork, com um `Meta.BackgroundGroup` atrás do dash, fora
do ator renderizado em offscreen. Assim o blur captura o fundo da tela em vez
da textura interna do dock. A camada segue a posição e o tamanho do fundo e é
removida ao desativar o efeito. O fork não depende da instalação daquela extensão. Não
inclui os pipelines, shaders ou o modo de papel de parede estático do projeto.

O blur respeita a opacidade e a cor calculadas pelo tema e pelas configurações
normais do Dash to Dock, incluindo os limites de transparência dinâmica. Não há
limite artificial de 30% e o efeito não reescreve a cor de preenchimento. O
contorno continua sendo aplicado quando a transparência muda devido às janelas.

## Cantos arredondados: mesmo backend do Blur my Shell

O fork tenta carregar `gi://Blur`, valida o tipo GObject da biblioteca externa
**GNOME Rounded Blur** e usa `Blur.BlurEffect` com `Blur.BlurMode.BACKGROUND`
quando disponível. Se a biblioteca estiver ausente ou incompatível, usa
`Shell.BlurEffect` com seu enum correspondente, como no Blur my Shell.

O slider **Raio dos cantos do desfoque (px)** controla a propriedade
`corner_radius`; tanto o raio de blur quanto o raio dos cantos são multiplicados
pela escala do monitor. O suporte à propriedade `corner-radius` é detectado no
backend escolhido. A seleção da biblioteca ocorre ao carregar a extensão.

Para arredondar o blur em versões do GNOME sem suporte nativo, instale a mesma
biblioteca utilizada pelo Blur my Shell, seguindo seu
[guia oficial de instalação](https://github.com/aunetx/blur-my-shell/blob/master/scripts/GUIDE.md).
A biblioteca não é incluída no ZIP: contém código nativo que precisa corresponder
à versão do GNOME Shell/Mutter instalada. Após instalar ou atualizar a biblioteca,
encerre a sessão e entre novamente. Uma biblioteca incompatível também é ignorada.
Sem essa biblioteca ou suporte nativo, o desfoque continua funcionando, mas não
pode aplicar o raio arredondado; ajustar o slider sozinho não resolve essa falta.

A implementação anterior usava apenas o backend `Shell`, por isso não aproveitava
os cantos da biblioteca mesmo se ela estivesse instalada. A versão 4 corrige isso.
Desative o blur de Dash to Dock no Blur my Shell se também o utilizar, para evitar
efeitos sobrepostos.

## Identidade do fork

- Nome: **Dash to Dock Soft**
- UUID: `dash-to-dock-soft@local`
- Schema: `org.gnome.shell.extensions.dash-to-dock-soft`
- Configurações: `/org/gnome/shell/extensions/dash-to-dock-soft/`
- Versão do fork: **11**
- Versões declaradas do GNOME Shell: **45–51**, herdadas do upstream.

O UUID e o schema próprios preservam a instalação e as configurações originais.
Desative o Dash to Dock original antes de ativar este fork, pois ambos controlam
o mesmo dash. O repositório deste fork é
[mcdalbu/dash-to-dock-soft](https://github.com/mcdalbu/dash-to-dock-soft).
O remoto `upstream` aponta para o projeto original.

## Instalar o ZIP

Na pasta que contém o ZIP:

```bash
gnome-extensions install dash-to-dock-soft@local_v11.zip
```

Encerre a sessão e entre novamente para que o GNOME Shell reconheça a nova extensão.
Depois:

```bash
gnome-extensions disable dash-to-dock@micxgx.gmail.com
gnome-extensions enable dash-to-dock-soft@local
gnome-extensions prefs dash-to-dock-soft@local
```

Se a versão original não estiver instalada, ignore o comando para desativá-la.
Para atualizar uma instalação existente do fork, use `gnome-extensions install --force`.

## Compilar a partir do código

Dependências: `make`, `glib-compile-schemas`, `gettext` (`msgfmt`), `sassc`
e `zip`. O alvo `check` também precisa de ESLint compatível com a configuração
legada do upstream (por exemplo, ESLint 8).

```bash
make
make check
node tests/dock-effects.cjs
make zip-file VERSION=11
```

Para instalar a partir da árvore de código:

```bash
make install
```

Também são suportados Dart Sass (`make SASS=dart`) e Ruby Sass
(`make SASS=ruby`), conforme o Makefile original.

## Novidade da versão 11

O painel Aparência inclui o slider **Intensidade do contorno (%)**, de 0% a
100%, com padrão de 15%. Zero deixa a borda transparente e 100% a deixa opaca.
O ajuste é salvo nas configurações e aplicado ao vivo, inclusive após mudanças
da transparência dinâmica. O contorno mantém a espessura de 1 px e os cantos
do tema, usando branco em fundos escuros e preto em fundos claros.

O padrão preserva os 15% anteriores em fundos escuros; em fundos claros,
substitui os 12% fixos pelos mesmos 15% definidos no slider. O controle fica
desabilitado quando o contorno está desligado, sem apagar o valor salvo.

Validado em sessão Wayland isolada do GNOME Shell 50.5: 0%, 15%, 65% e 100%
em fundos claros e escuros, sem alterar a opacidade do preenchimento. O teste
GTK construiu o controle de `Settings.ui` e executou os vínculos de `prefs.js`,
verificando atualização bidirecional, limites, sensibilidade e restauração
do padrão. Resultados em `validation/gnome50-outline-results.json` e captura
do controle em `validation/gnome50-outline-preferences.png`.

## Correção da versão 10

O blur dinâmico captura pixels do framebuffer fora da região de dano do
compositor. Em um redesenho parcial, esses pixels podem conter o dock do frame
anterior, produzindo blocos retangulares durante hover, animações ou mudanças
das janelas. Invalidar apenas a camada de blur não elimina essa causa.

O fork agora desativa os redesenhos recortados durante cada frame já agendado
de um monitor que contém blur visível. A configuração é restaurada depois
da atualização do frame, ao desativar o blur e ao destruir o dock. Monitores
sem blur, atores não mapeados e atores com opacidade zero não ativam a proteção.
Docks simultâneos compartilham a proteção; flags já ativadas antes do frame
são preservadas. São usadas as APIs Clutter atuais e Meta nas versões antigas.

A proteção não solicita frames adicionais nem mantém um timer em repouso.
Redesenhar o monitor inteiro aumenta o trabalho da GPU enquanto há atualizações
com blur visível. Essa troca evita depender exclusivamente das notificações
de estilo e de janela para prevenir os artefatos de captura parcial.

Validado em sessão Wayland headless isolada do GNOME Shell 50.5 com GNOME
Rounded Blur: 41 frames pintados com a proteção ativa, restauração após todos
os frames e nenhuma pintura durante 1,5 s em repouso. A desativação removeu
o guard e o ator de blur, com as flags restauradas. Resultados em
`validation/gnome50-frame-guard-results.json` e captura em
`validation/gnome50-frame-guard.png`. A captura particular do usuário não foi
reproduzida nesta sessão; o teste verifica o novo caminho do compositor.

## Novidade da versão 9

Além da opacidade, o painel Aparência permite ajustar os deslocamentos
horizontal e vertical e o desfoque da sombra dos ícones. Valores negativos
movem a sombra para a esquerda ou para cima; desfoque zero produz uma sombra
nítida. Os padrões anteriores de 0 px, 2 px e 4 px foram mantidos.

A regra de sombra é carregada numa folha de estilo temporária, limitada a cada
dock. Ela acompanha ícones novos sem substituir seus estilos inline. A folha
é atualizada ao alterar os controles ou trocar o tema, e é removida ao
desativar a sombra ou descarregar o fork. As traduções em português foram
atualizadas.

Validado numa sessão Wayland isolada do GNOME Shell 50.5: alterações ao vivo,
valores negativos, desfoque zero, ícones recriados/adicionados, escala 2× e
remoção da folha temporária. Os sliders GTK também passaram na verificação
dos limites, padrões, sensibilidade e vínculo bidirecional. O blur não
continuou repintando em repouso. Os resultados estão em
[`validation/gnome50-shadow-results.json`](validation/gnome50-shadow-results.json).

## Correção da versão 8

As mudanças de estilo dos widgets do dash, incluindo hover e foco, agora
invalidam a camada inteira do blur durante a transição CSS. A duração vem do
nó de tema de cada widget, com uma margem de 50 ms para a pintura final. Isso
cobre os frames posteriores à entrada e à saída do cursor, que antes não eram
acompanhados pelas notificações de janela adicionadas na versão 7.

O acompanhamento inclui widgets adicionados e removidos durante o uso. O
callback de frame não solicita novas pinturas após o prazo da transição, e os
handlers são desconectados quando o blur é desativado. A opacidade, os cantos,
as sombras e o destaque normal de hover continuam independentes do blur.

Teste em GNOME Shell 50.5 isolado: cinco botões percorridos, com blur,
contorno e sombra dos ícones em 65%. O efeito foi atualizado durante as
transições e deixou de repintar durante 1,2 s em repouso. A desativação limpou
os handlers e o prazo de atualização. Resultados em
`validation/gnome50-hover-results.json`; capturas em
`validation/gnome50-hover-transition.png` e `validation/gnome50-hover-settled.png`.
O quadrado transitório relatado não foi reproduzido na versão 7 com este
renderizador de software; o teste confirma o novo caminho de atualização,
não a ausência do artefato em todos os drivers.

## Correção da versão 7

O blur passou a acompanhar as notificações `damaged` dos atores de janela,
além das mudanças de posição, visibilidade e ordem das janelas. Quando uma
janela afeta a área do dock, o código invalida a camada inteira do desfoque
antes da próxima pintura, em vez de reutilizar a imagem de um redesenho parcial.
Notificações repetidas são agrupadas em uma atualização por frame.

A área anterior também é atualizada quando a janela sai de trás do dock. A
margem de verificação inclui as sombras e o raio do blur. As conexões e as
atualizações pendentes são removidas ao desativar o efeito. Não é usado um
timer contínuo nem alterada a configuração global de redesenho do compositor.
A cor e a opacidade configuradas são preservadas.

Teste em sessão headless isolada do GNOME Shell 50.5, com uma janela GTK
animada atrás do dock visível: oito capturas mantiveram a mesma cor na área
uniforme amostrada do fundo. As atualizações pararam quando a janela ficou
inativa, e a desativação removeu as conexões e callbacks. O dock foi mantido
visível pelo teste para evitar as restrições da área de trabalho. Resultados em
`validation/gnome50-window-repaint-results.json` e captura em
`validation/gnome50-window-behind-dock.png`. Isso não garante a ausência de
todos os artefatos transitórios em outros drivers ou na sessão do usuário.

## Correção da versão 6

O limite de opacidade de 30% introduzido nas primeiras versões foi removido.
O blur apenas desativa imagens de fundo opacas e aplica seu efeito na camada
atrás do dock; não reescreve a declaração de cor ou opacidade. A intensidade
do blur e a opacidade do preenchimento são controles independentes.

Verificação real no GNOME Shell 50.5: 0%, 10%, 30%, 65%, 90% e 100% foram
aplicados com blur ativo, com tolerância de um nível do canal alpha de 8 bits.
Os valores registrados estão em `validation/gnome50-opacity-results.json`.

## Correção da versão 5

A versão anterior concatenava o estilo de transparência com um ponto e vírgula
extra (`;;`). O parser St do GNOME 50 não aplicava as declarações seguintes;
o preenchimento continuava opaco e escondia o blur. A versão 5 corrige a junção
das declarações e inclui uma verificação de regressão para esse formato inválido.

A falha foi reproduzida e a correção verificada numa sessão isolada do GNOME
Shell 50.5 com um monitor virtual de 1280×720. O backend GNOME Rounded Blur
foi carregado e o fundo quadriculado em faixas foi capturado com o efeito ligado
e com sua camada escondida. O preenchimento passou de `#38383bff` para
`#38383b4c`, conforme a opacidade esperada, e as faixas ficaram desfocadas com
os ícones nítidos. Os cantos arredondados também preservaram o fundo externo.
Veja `validation/gnome50-blur-on.png` e `validation/gnome50-blur-layer-hidden.png`
na árvore de código. Esses arquivos são capturas de um ambiente de teste,
não da área de trabalho do usuário.

## Validação desta entrega

- Compilação com `make` e validação estrita dos schemas: passaram.
- Sintaxe JavaScript, XML e IDs do GtkBuilder: passaram.
- Carregamento do schema empacotado, alteração e restauração das novas opções
  pelo GSettings com backend em memória e vínculo bidirecional do controle
  de intensidade com GtkAdjustment: passaram.
- Testes com mocks em `tests/dock-effects.cjs`: contorno só no fundo,
  restauração do tema, transparência dinâmica, reuso e remoção de efeitos,
  intensidade da sombra, camada de blur externa ao dash e sua geometria,
  intensidade do blur, escala, API antiga (`sigma`), seleção de backend,
  enum da biblioteca de compatibilidade, raio dos cantos e isolamento entre docks.
  Isso não substitui um teste visual no GNOME Shell.
- Teste real do carregador em GJS: selecionou `GbBlurEffect` da biblioteca
  GNOME Rounded Blur instalada, com propriedade `corner-radius` disponível.
- Introspecção da API local do GNOME Shell 50: confirma `radius`, `brightness`
  e `mode`; o efeito não pode ser instanciado fora do processo GNOME Shell.
- `make check`: não executado com sucesso porque ESLint não está instalado.
- Renderização real e inspeção de capturas: passaram no GNOME Shell 50.5
  em sessão headless isolada, com GNOME Rounded Blur. Outras versões do GNOME
  e a sessão particular do usuário não foram testadas.

## Créditos e licença

Este fork é mantido por **[mcdalbu](https://github.com/mcdalbu)**, responsável
pelo projeto Dash to Dock Soft e suas opções de aparência.

Dash to Dock foi criado por Michele G. (`micxgx@gmail.com`) e colaboradores.
O código e os créditos originais foram preservados. A licença continua sendo
GNU GPL versão 2 ou posterior; veja [COPYING](COPYING).

Relate problemas específicos das novas opções ao mantenedor deste fork, junto
com a versão do GNOME Shell, o tema e a configuração usada. Não encaminhe
problemas exclusivos deste fork ao projeto original.
