"""
言語モデル構築用の組み込みコーパス。

ファイル外部依存をなくすため、英語とローマ字日本語の自然な文章を
それぞれ十分な量（数千文字）埋め込んでいる。これらから実行時に
n-gram統計を生成する。
"""

ENGLISH_CORPUS = """
The quick brown fox jumps over the lazy dog. Pack my box with five
dozen liquor jugs. The five boxing wizards jump quickly. How vexingly
quick daft zebras jump. Sphinx of black quartz judge my vow.
Time is what we want most but what we use worst. We do not remember
days we remember moments. The only way to do great work is to love
what you do. The future belongs to those who believe in the beauty
of their dreams. Life is what happens when you are busy making other
plans. The way to get started is to quit talking and begin doing.
You miss one hundred percent of the shots you do not take. Whether
you think you can or you think you cannot you are right. The best
time to plant a tree was twenty years ago the second best time is
now. People who are crazy enough to think they can change the world
are the ones who do. Imagination is more important than knowledge.
Do not watch the clock do what it does keep going. The journey of
a thousand miles begins with a single step. That which does not kill
us makes us stronger. Be yourself everyone else is already taken.
Two things are infinite the universe and human stupidity and I am
not sure about the universe. A room without books is like a body
without a soul. You only live once but if you do it right once is
enough. Be the change that you wish to see in the world. In three
words I can sum up everything I have learned about life it goes on.
If you tell the truth you do not have to remember anything. To live
is the rarest thing in the world most people exist that is all.
There is no greater agony than bearing an untold story inside you.
We accept the love we think we deserve. So many books so little time.
The man who does not read has no advantage over the man who cannot
read. A reader lives a thousand lives before he dies the man who
never reads lives only one. You can never get a cup of tea large
enough or a book long enough to suit me. So it goes. Insanity is
doing the same thing over and over again and expecting different
results. Whatever you are be a good one. Hello world this is just
a sample of english text used to build a basic statistical language
model for cryptanalysis purposes the more text we have the better
the model will be at distinguishing genuine english from random
gibberish produced by incorrect decryption attempts. We need words
of varying lengths common patterns letter combinations and natural
sentence structures. The most common letters in english are e t a
o i n s h r d l u and the most common bigrams are th he in er an
re on at en nd ti es or te of ed is it al ar st to nt ng se ha as
ou io le ve co me de hi ri ro ic ne ea ra ce. Common trigrams in
english include the and ing her hat his tha ere for ent ion ter was
you ith ver all wit thi tio out can has the. Words like that this
with from they have been will their what about which would there
could should other these many some time make like into year your
good well after first work even back over also know just take into
also some most each find give that those people because between
through during without before against another around perhaps however
moreover therefore furthermore consequently nevertheless. Reading
literature reveals patterns and rhythms that random text cannot
match. Every paragraph builds on common phrases and idiomatic
constructions natural to native speakers. The morning sun rose over
the quiet town as people began their daily routines walking to work
or school carrying their bags and thoughts about the day ahead.
Children laughed in the park while old men played chess on weathered
boards under shady trees. Coffee shops filled with the smell of
fresh pastries and the sound of conversations both deep and shallow.
"""


ROMAJI_CORPUS = """
watashi wa nihonjin desu. anata wa gakusei desu ka. kore wa nan
desu ka. sore wa hon desu. are wa kuruma desu. kyou wa ii tenki
desu ne. ashita wa ame ga furu kamoshiremasen. nihongo o benkyou
shite imasu. eigo mo sukoshi wakarimasu. sumimasen ga toire wa
doko desu ka. arigatou gozaimasu. dou itashimashite. hajimemashite
watashi no namae wa tanaka desu yoroshiku onegaishimasu. ohayou
gozaimasu. konnichiwa. konbanwa. oyasumi nasai. itte kimasu. itte
rasshai. tadaima. okaeri nasai. itadakimasu. gochisousama deshita.
ogenki desu ka. hai genki desu. iie chigaimasu. wakarimasen. mou
ichido onegaishimasu. chotto matte kudasai. nan to iimasu ka. ima
nanji desu ka. ku ji han desu. kyou wa nanyoubi desu ka. ashita
wa getsuyoubi desu. raishuu no kayoubi ni aimashou. densha de
ikimasu. basu ni norimasu. takushi o yobimasu. hoteru wa eki no
chikaku desu. heya no kagi o kudasai. asagohan wa nanji kara desu
ka. kohi o onegaishimasu. omizu o kudasai. biiru o nihai onegai
shimasu. totemo oishikatta desu. mata raishuu kimasu. ki o tsukete
kudasai. yukkuri hanashite kudasai. nihon ni sunde imasu. tokyo
no chuushin de hataraite imasu. kazoku to issho ni sunde imasu.
chichi to haha to ototo to imouto ga imasu. shumi wa hon o yomu
koto desu. ongaku mo daisuki desu. eiga o miru no ga suki desu.
sakkaa o shimasu. yakyuu o mimasu. shashin o torimasu. ryokou ni
iku no ga suki desu. raigetsu kuni ni kaerimasu. kuukou de aimashou.
densha no chiketto wa ikura desu ka. kankoku ni iku tsumori desu.
chuugoku ni mo ikitai desu. amerika ni sunde ita koto ga arimasu.
furansugo wa hanasemasen. itariago wa sukoshi dake hanasemasu. eigo
wa pera pera desu. nihongo wa muzukashii desu. demo totemo tanoshii
desu. ganbatte kudasai. shitsumon ga arimasu. kotaete kudasai. tsugi
no peeji o mite kudasai. kyoukasho o akete kudasai. nooto ni
kakimashou. sensei ni kikimashou. tomodachi to issho ni asobimasu.
asagohan o tabemashita. hirugohan wa pasta deshita. yorugohan ni
sushi o tabemasu. ringo to mikan to budou ga suki desu. yasai mo
takusan tabemasu. niku yori sakana no hou ga suki desu. ocha o
nomimashou. biiru wa amari nomimasen. nihonshu wa tsuyoi desu.
kafe ni hairimashou. keeki o tabemasen ka. chokoreeto wa amai
desu. karai mono mo suki desu. ryouri o tsukuru no ga suki desu.
oishii desu ne. mou ippai onegaishimasu. omizu de ii desu. hashi
o tsukatte tabemasu. naifu to fooku mo arimasu. kanji wa muzukashii
desu. hiragana to katakana wa kantan desu. benkyou ga taihen desu.
kondo shiken ga arimasu. zettai ni gokaku shitai desu. ganbarimasu.
sukoshi yasumimashou. ato de ikimashou. shumatsu ni doko ka ikimasu
ka. yama ni noborimasu. umi de oyogimasu. onsen de yukkuri shimasu.
matsuri ni ikimashou. hanabi o mimashita. totemo kirei deshita.
sakura ga saite imasu. haru wa atatakai desu. natsu wa atsui desu.
aki wa suzushii desu. fuyu wa samui desu. yuki ga furimashita.
kasa o motte ikimasu. kooto o kite kudasai. boushi o kabutte imasu.
kutsu o nuide kudasai. denwa ga narimashita. moshi moshi tanaka
desu. ima isogashii desu. ato de denwa shimasu. meeru o okurimasu.
intaanetto de shirabete kudasai. konpyuutaa o tsukaimasu. sumaho
de shashin o torimashita. omoshiroi douga o mimashita. shinbun o
yomimasu. terebi o mimasu. nyuusu o kikimasu. tenki yohou wa
ashita ame desu. kasa o wasurenaide kudasai. ohayou gozaimasu
kyou mo ichinichi ganbarimashou. otsukaresama deshita. mata ashita
aimashou. yoi shumatsu o. yoi ichinichi o sugoshite kudasai. genki
de ne. ki o tsukete kaette kudasai. mata renraku shimasu. tanoshikatta
desu. arigatou gozaimashita. wasuremono ga nai you ni shite kudasai.
saifu to kagi to keitai o motte imasu ka. junbi ga dekimashita.
ikimashou. soto wa samui desu. uchi no naka wa atatakai desu.
sutoobu o tsukemashou. mado o shimete kudasai. doa o akete kudasai.
denki o keshite kudasai. terebi no oto o chiisaku shite kudasai.
hon o yonde imasu. ongaku o kiite imasu. kohi o nonde imasu.
yoyaku ga arimasu. yoyaku o henkou shitai no desu ga. ashita no
gogo ni kaete kudasai. wakarimashita. arigatou gozaimasu. tasukari
mashita. dou itashimashite. mata kondo onegaishimasu. shitsurei
shimasu. shitsurei shimashita. moushiwake arimasen. daijoubu desu.
ki ni shinaide kudasai. tasukete kudasai. abunai. kiken desu.
chuui shite kudasai. ki o tsukete. yamete kudasai. iya desu.
sukidesu. aishite imasu. tomodachi desu. shinsetsu desu ne.
yasashii hito desu. kakkoii desu. kawaii desu. kirei desu.
suteki desu. omoshiroi desu. tsumaranai desu. tanoshii desu.
ureshii desu. kanashii desu. samishii desu. okotte imasu. nayande
imasu. komatte imasu. ureshikatta desu. yokatta desu. zannen desu.
shouganai desu. shikata ga arimasen. ganbatte. ouen shite imasu.
itsumo arigatou. zutto issho ni iyou. yakusoku shimasu.
mata aimashou. sayounara. genki de.
"""
