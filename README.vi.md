# pi-model-roles

Gán model theo **role**, không gán theo từng agent.

Thay vì ghim model id ở mười chỗ khác nhau — default của bạn, từng file định
nghĩa subagent, từng lời gọi spawn — bạn giữ đúng một bảng:

```
@default   → anthropic/claude-sonnet-4-5
@smol      → anthropic/claude-haiku-4-5      (fallback: openai/gpt-4.1-mini)
@slow      → anthropic/claude-opus-4-5:high
@designer  → @slow
```

…và mọi thứ còn lại chỉ tham chiếu tới role. Đổi model sau `@smol` một lần là
mọi scout, mọi lần recon, mọi tra cứu rẻ tiền đi theo.

Đây là ý tưởng `modelRoles` của [Oh My Pi](https://omp.sh) dựng lại trên API
extension công khai của [pi](https://github.com/earendil-works/pi). Pi không có
khái niệm role: nó chỉ có `defaultModel`, `enabledModels`, và frontmatter của
từng agent — không có gì nối chúng lại với nhau.

> **English docs:** [README.md](README.md)

---

## Mục lục

- [Cài đặt](#cài-đặt)
- [Bắt đầu nhanh](#bắt-đầu-nhanh)
- [Các role](#các-role)
- [Cấu hình](#cấu-hình)
- [TUI `/roles`](#tui-roles)
- [Lệnh](#lệnh)
- [Ghép với subagent](#ghép-với-subagent)
- [Advisor](#advisor)
- [Compaction](#compaction)
- [Cơ chế bên trong](#cơ-chế-bên-trong)
- [Giới hạn](#giới-hạn)
- [Xử lý sự cố](#xử-lý-sự-cố)
- [Phát triển](#phát-triển)
- [So với OMP](#so-với-omp)

---

## Cài đặt

Yêu cầu pi `>= 0.85.0`.

**Dạng pi package (khuyến nghị)**

```bash
pi install git:github.com/thucpru/pi-model-roles
```

Chỉ cho một project:

```bash
pi install -l git:github.com/thucpru/pi-model-roles
```

**Dạng extension global thủ công**

```bash
git clone https://github.com/thucpru/pi-model-roles \
  ~/.pi/agent/extensions/model-roles
```

Pi tự quét `~/.pi/agent/extensions/*/index.ts`, không cần khai báo gì thêm.

**Dùng thử một phiên, không cài**

```bash
pi -e /đường/dẫn/pi-model-roles
```

> Chọn **một** cách thôi. Vừa cài package vừa clone vào
> `~/.pi/agent/extensions/` sẽ load extension hai lần: `/roles` đăng ký hai lần
> và model của subagent bị gán hai lần.

**Gỡ**

```bash
pi remove git:github.com/thucpru/pi-model-roles   # nếu cài dạng package
rm -rf ~/.pi/agent/extensions/model-roles          # nếu cài thủ công
```

File `model-roles.json` vẫn được giữ lại; muốn sạch hẳn thì xoá tay.

## Bắt đầu nhanh

```bash
pi
```

```
/roles
```

Chọn role → chọn model → thêm fallback. Bảng được ghi vào
`~/.pi/agent/model-roles.json` ngay khi bạn thao tác.

Sau đó, ở bất kỳ đâu:

```
/role slow        # chuyển phiên hiện tại sang model + thinking của @slow
/role             # liệt kê mọi role và model nó đang resolve ra
/advisor on       # bật giám sát (phải gán model cho @advisor trước)
```

Thích sửa JSON hơn? Copy [`model-roles.example.json`](model-roles.example.json)
sang `~/.pi/agent/model-roles.json` rồi chỉnh.

## Các role

Mười role dựng sẵn. Tất cả đều không bắt buộc — role chưa gán sẽ rơi về
`@default`.

| Role | Dùng cho |
| --- | --- |
| `@default` | Phiên chính, tác vụ hằng ngày |
| `@smol` | Việc nhẹ và nhanh: scout, grep, đọc file, "cái này làm gì" |
| `@slow` | Suy luận sâu: debug khó, kiến trúc, refactor rối |
| `@vision` | Phân tích ảnh, screenshot |
| `@plan` | Brainstorm và lập kế hoạch |
| `@designer` | Frontend design, UI/UX |
| `@commit` | Việc git: commit message, đọc diff, mô tả PR |
| `@tiny` | Việc siêu nhỏ: tóm tắt, phân loại, đặt tên |
| `@task` | Executor mặc định cho subagent được giao việc |
| `@advisor` | Giám sát: review từng turn và điều phối công việc |

Tự tạo role riêng trong TUI hoặc thêm key vào `roles`. Role tự tạo hoạt động y
hệt role dựng sẵn, và là loại duy nhất TUI cho phép xoá.

## Cấu hình

### Vị trí file và thứ tự ưu tiên

| Phạm vi | Đường dẫn |
| --- | --- |
| Global | `~/.pi/agent/model-roles.json` |
| Project | `<cwd>/.pi/model-roles.json` |

File project merge đè lên global **theo từng role** và **từng ánh xạ agent** —
một project có thể chỉ đè `@slow` và thừa hưởng phần còn lại. File project chỉ
được đọc khi project đã được pi trust.

TUI ghi vào phạm vi đang hiện ở footer; phím `s` đổi qua lại.

Config hỏng thì bị bỏ qua chứ không làm pi chết: pi vẫn khởi động, các role đọc
ra là chưa gán.

### Cú pháp selector

Mọi giá trị `model` và mọi phần tử `fallback` đều là một **selector**:

| Dạng | Ví dụ | Khớp với |
| --- | --- | --- |
| `provider/id` | `anthropic/claude-opus-4-5` | đúng model đó |
| id trần | `gpt-5.2` | model id đó ở bất kỳ provider nào |
| fuzzy | `haiku` | model khả dụng đầu tiên có `provider/id` hoặc tên chứa chuỗi đó |
| alias | `@slow` | bất kỳ thứ gì `@slow` resolve ra |

Dạng nào cũng gắn được hậu tố thinking: `:off`, `:minimal`, `:low`, `:medium`,
`:high`, `:xhigh`, `:max`.

```jsonc
"slow": { "model": "anthropic/claude-opus-4-5:high" }
```

Thứ tự khớp: `provider/id` chính xác → id chính xác → fuzzy trên `provider/id` →
fuzzy trên tên hiển thị. Chỉ xét những model tài khoản bạn thật sự dùng được.

### Chuỗi fallback

`fallback` là danh sách có thứ tự, thử sau `model`. Phần tử đầu tiên resolve
được sẽ thắng.

```jsonc
"slow": {
  "model": "anthropic/claude-opus-4-5",
  "thinking": "high",
  "fallback": ["openai/gpt-5.2:high", "@default"]
}
```

Provider chết, key hết hạn, model biến mất khỏi catalog — role xuống cấp chứ
không gãy. TUI đánh dấu role đang chạy bằng fallback là `◐`.

Nếu cả chuỗi không resolve được, role rơi về `@default` một lần, và TUI đánh dấu
`✗` để bạn biết bảng đang nói dối mình.

### Alias

Selector bắt đầu bằng `@` trỏ tới role khác:

```jsonc
"designer": { "model": "@slow" },
"plan":     { "model": "@slow:medium" }
```

Alias thừa hưởng model của role đích. Hậu tố thinking ở role *trỏ tới* thắng —
nên `@plan` ở trên chạy model của `@slow` với `medium`, còn bản thân `@slow` vẫn
`high`. Vòng lặp alias được phát hiện và dừng, không đệ quy vô hạn.

### Bảng khoá đầy đủ

```jsonc
{
  "roles": {
    "<tên>": {
      "model": "provider/id | id | fuzzy | @role",        // tuỳ chọn
      "thinking": "off|minimal|low|medium|high|xhigh|max", // tuỳ chọn
      "fallback": ["selector", "..."],                     // tuỳ chọn, có thứ tự
      "description": "hiện trong TUI và gửi cho advisor"   // chỉ role tự tạo
    }
  },

  // tên file định nghĩa subagent -> tên role
  "agentRoles": { "scout": "smol", "worker": "task" },

  "advisor": {
    "enabled": false,          // công tắc chính
    "everyTurns": 1,           // review mỗi N turn hoàn tất
    "mode": "advise",          // "advise" | "steer"
    "minSeverity": "concern",  // "note" | "concern" | "blocker"
    "maxNotes": 3              // giới hạn số note và số việc giao mỗi lần review
  },

  // chèn bảng tóm tắt role vào system prompt để model dùng được @alias
  "injectPrompt": true,

  // role dùng để tóm tắt khi compaction; null = để nguyên mặc định của pi
  "compactionRole": null
}
```

## TUI `/roles`

`/roles` mở một bảng hai khung: role của bạn ở trái, danh mục model đang dùng
được ở phải.

```
  Model roles   one table the whole session reads from

  ROLES                                │ MODELS 12  type to filter
  ▸ ● @default  claude-sonnet-4-5      │ ▸ ● claude-sonnet-4-5      anthropic · 200K ctx · vision · $3/$15
    ◐ @smol     gpt-4.1-mini ↓1 +1     │     claude-haiku-4-5       anthropic · 200K ctx · vision · $1/$5
    ● @slow     claude-opus-4-5:high   │     claude-opus-4-5        anthropic · 200K ctx · reasoning
    ✗ @vision   — not set —            │     gpt-5.2                openai · 272K ctx · vision · $1.25/$10
    ● @designer claude-opus-4-5:high   │     gpt-4.1-mini           openai · 1M ctx · $0.4/$1.6
    ○ @commit   — not set —            │

  @default  Main session / primary work
  chain   anthropic/claude-sonnet-4-5
  resolves anthropic/claude-sonnet-4-5   thinking inherit

  ↑↓ move · tab → models · enter use in session · t thinking · x clear model …
  s scope:global · i prompt:on · c compact:off · v advisor:off · n new · d delete …
```

**Đổi model của một role tốn bốn thao tác**: chọn role, `tab`, gõ vài chữ,
`enter`. Danh mục luôn hiện trên màn hình nên bạn không phải nhớ tài khoản mình
chạy được model nào — và nó hiện luôn giá, có vision hay reasoning không, ngay
lúc bạn đang chọn.

**Dấu trong danh mục** cho biết role đang chọn dùng model đó thế nào: `●` là
model chính, `①②③` là fallback theo thứ tự. Dấu này bám theo selector fuzzy và
`@alias`, nên role cấu hình là `haiku` vẫn đánh dấu đúng model nó resolve ra.

**Khung MODELS**

| Phím | Tác dụng |
| --- | --- |
| gõ chữ | lọc fuzzy danh mục (theo `prov/id` và tên, token cách nhau bằng dấu cách hoặc `/`) |
| `backspace` / `ctrl+u` | sửa / xoá bộ lọc |
| `enter` | đặt model đang chọn làm **model chính** của role |
| `ctrl+f` | thêm nó vào **chuỗi fallback** của role |
| `tab` / `←` | quay lại khung ROLES |

**Khung ROLES**

| Phím | Tác dụng |
| --- | --- |
| `enter` | chuyển phiên hiện tại sang model của role này |
| `t` | xoay vòng mức thinking, hết vòng quay về inherit |
| `x` | xoá model chính, giữ nguyên fallback |
| `-` | bỏ fallback cuối |
| `p` | đưa fallback #1 lên làm chính, model chính cũ xuống fallback |
| `n` / `d` | tạo role tự tạo / xoá role tự tạo đang chọn |
| `a` / `v` | ánh xạ agent → role / cấu hình advisor |
| `s` / `i` / `c` | phạm vi lưu / cheat-sheet trong prompt / role cho compaction |
| `?` / `esc` | bảng phím / đóng |

**Ký hiệu trạng thái**

| Ký hiệu | Nghĩa |
| --- | --- |
| `●` | model chính resolve được |
| `◐` | model chính hỏng, fallback đang gánh (`↓1` cho biết fallback thứ mấy) |
| `✗` | cả chuỗi không resolve được — role đang mượn `@default` |
| `○` | chưa cấu hình gì |

`+2` sau tên role nghĩa là role đó có hai fallback.

Mọi thay đổi được ghi xuống đĩa ngay, không có bước lưu. Những hộp thoại cần gõ
chữ — đặt tên role mới, xác nhận xoá, ánh xạ agent, cấu hình advisor — sẽ đóng
bảng, chạy, rồi trả bạn về đúng chỗ cũ.

**Terminal hẹp.** Dưới 80 cột, bảng hiện một khung tại một thời điểm và `tab`
đổi qua lại; mọi thứ khác không đổi.

**Chế độ không tương tác.** Trong RPC, JSON và print mode không có terminal để
vẽ, nên `/roles` rơi về cây menu dựng trên `ctx.ui.select` / `input` / `confirm`
với đầy đủ chức năng tương đương.

## Lệnh

| Lệnh | Tác dụng |
| --- | --- |
| `/roles` | Mở TUI cấu hình đầy đủ |
| `/role` | Liệt kê mọi role và model nó đang resolve ra |
| `/role <tên>` | Chuyển phiên hiện tại sang model + thinking của role đó |
| `/advisor` | Xem trạng thái advisor |
| `/advisor on` \| `/advisor off` | Bật/tắt advisor và lưu lại |

Thay đổi bằng `/role` chỉ áp cho phiên hiện tại: pi ghi vào lịch sử session và
khôi phục khi resume, còn `defaultModel` đã cấu hình không bị đụng tới.

## Ghép với subagent

Một hook `tool_call` duy nhất phủ mọi tool spawn trong hệ sinh thái:

| Tool | Thuộc |
| --- | --- |
| `subagent` | [pi-interactive-subagents](https://github.com/amosblomqvist/pi-interactive-subagents) |
| `agent` | `@xynogen/pix-subagent` |
| `subagent_delegate` | `@d3ara1n/pi-subagent` |
| `subagent_run` | `pi-subagents-j0k3r` |
| `task` | chung |

**Cách chọn model**

| Lời gọi ghi | Kết quả |
| --- | --- |
| không có `model` | role được map cho agent đó trong `agentRoles`, không có thì `@task` |
| `model: "@slow"` | đúng role đó |
| `model: "@slow:medium"` | role đó với thinking `medium` |
| `model: "anthropic/claude-opus-4-5"` | giữ nguyên — model cụ thể là quyết định của người gọi |

Với `subagent`, giá trị được ghi dạng `provider/id:thinking` vì đó là thứ tham
số `--model` của nó nhận. Với tool có tham số `thinking` riêng, mức thinking đặt
vào đó và model để trần.

**Hook này cũng đè `model:` trong frontmatter của agent.** Thường đó đúng là thứ
bạn muốn: `pi-interactive-subagents` ship sẵn `scout`, `researcher`, `worker`
ghim cứng `openrouter/z-ai/glm-5.3` — không có provider đó là spawn hỏng. Map
chúng vào role một lần là chúng chạy bằng model bạn thật sự có.

**Cho model tự dùng alias.** Với `injectPrompt: true` (mặc định), một bảng tóm
tắt ngắn được nối vào system prompt:

```
## Model roles
When you spawn a subagent you may pass a role alias as the model, e.g.
`subagent({ agent: "scout", model: "@smol", task: "..." })`. Omit the model and the
agent's mapped role is used automatically. Available roles:
- @smol: Cheap and fast — scouting, greps, recon (anthropic/claude-haiku-4-5)
- @slow: Deep reasoning, hard debugging, architecture (anthropic/claude-opus-4-5:high)
...
```

Chỉ những role thật sự resolve được mới được liệt kê, nên model không bao giờ
được kể về một role nó không dùng được. Tắt trong TUI nếu bạn tiếc prompt budget.

## Advisor

`@advisor` là model thứ hai, đọc từng turn vừa xong và trả lời ba câu hỏi: agent
chính có đang đi đúng hướng không, nó đang bỏ sót gì, và **subagent nào nên nhận
phần việc tiếp theo, chạy bằng model của role nào**.

Mặc định tắt. Gán model cho `@advisor` rồi `/advisor on`.

**Nó nhìn thấy gì**

- prompt của người dùng ở turn hiện tại
- phần text assistant của turn vừa kết thúc
- tóm tắt (đã cắt bớt) các tool call trong turn đó
- bảng role đang sống, kèm model mà từng role resolve ra
- danh sách agent đang sống, kèm mô tả, tools, và role được map

**Nó trả về gì** — JSON nghiêm ngặt, được parse phòng thủ (chấp nhận code fence
và văn xuôi bao quanh, reply hỏng thì bỏ):

```json
{
  "severity": "ok | note | concern | blocker",
  "summary": "một câu về tình trạng công việc",
  "notes": ["quan sát cụ thể, hành động được"],
  "delegate": [
    { "agent": "scout", "role": "smol", "task": "prompt tự chứa", "why": "một dòng" }
  ]
}
```

**Bạn thấy gì** — verdict được render và steer vào phiên:

```
**Advisor (concern)** — The auth refactor is proceeding without checking callers.

- src/auth/session.ts changed shape; 4 call sites were not visited.

Dispatch these now:
- `subagent({ agent: "scout", model: "@smol", task: "List every call site of createSession" })`
  → @smol = anthropic/claude-haiku-4-5 · recon is cheap, run it in parallel
```

**Ba tầng, không tầng nào lấn quyền tầng khác**

```
advisor      quyết định AI LÀM        (agent nào, role nào)
bảng role    quyết định CHẠY BẰNG GÌ  (role → model cụ thể)
agent chính  quyết định CÓ LÀM KHÔNG  (nó mới là bên gọi tool)
```

Advisor không bao giờ tự spawn. Nó nêu tên agent; hook `tool_call` gán model của
role khi agent chính thực sự hành động.

**Hai mode**

- `advise` — báo cáo phát hiện và kế hoạch đề xuất; agent chính tự quyết.
- `steer` — như trên, cộng thêm chỉ thị dispatch ngay trong turn hiện tại.

**Kiểm soát chi phí.** `everyTurns` giới hạn tần suất review; verdict dưới
`minSeverity` vẫn tính nhưng không chèn; `maxNotes` chặn số note và số việc giao;
turn không sinh ra text lẫn tool call thì bỏ qua, không tốn một lời gọi nào;
review không chồng nhau; và review lỗi chỉ thành một cảnh báo chứ không cắt
ngang phiên làm việc.

Vì review chạy ở `turn_end`, bật advisor tốn thêm một lời gọi model mỗi turn
được review và làm turn kế tiếp chờ đúng độ trễ đó. Nếu bạn quan tâm chi phí,
bắt đầu với `everyTurns: 2` và `minSeverity: "concern"`.

## Compaction

`compactionRole` giao việc tóm tắt ngữ cảnh cho một role rẻ hơn:

```jsonc
"compactionRole": "tiny"
```

`null` (mặc định) để nguyên compaction sẵn có của pi. Gặp bất kỳ lỗi nào —
không có model, tóm tắt rỗng, request hỏng — nó lặng lẽ quay về mặc định của pi
chứ không làm mất bản tóm tắt.

## Cơ chế bên trong

Năm hook công khai của pi, không vá lõi:

| Hook | Dùng để |
| --- | --- |
| `session_start` | nạp lại config theo cwd của phiên |
| `before_agent_start` | bắt prompt người dùng; nối bảng tóm tắt role vào system prompt |
| `tool_call` | ghi đè `input.model` của tool spawn (`event.input` mutable) |
| `session_before_compact` | tóm tắt bằng model của `compactionRole` |
| `turn_end` | chạy review của advisor và steer verdict trở lại |

Cộng với `pi.registerCommand`, `pi.setModel` / `pi.setThinkingLevel`,
`ctx.modelRegistry` để đọc catalog và gọi `complete()`, và `pi.sendMessage` để
chèn kết quả advisor.

**Bố cục file**

| File | Trách nhiệm |
| --- | --- |
| `types.ts` | type, hằng số, giá trị mặc định — không import pi, không import fs |
| `config.ts` | vị trí file, merge, ghi atomic |
| `resolve.ts` | resolve role → model: alias, fallback, matching, health |
| `agents.ts` | quét định nghĩa subagent ở thư mục user/project/package |
| `board.ts` | bảng hai khung của `/roles` (chỉ import pi-tui nên test headless được) |
| `ui.ts` | cây menu dự phòng và các hộp thoại bảng giao lại |
| `advisor.ts` | prompt advisor, parse JSON, render verdict |
| `index.ts` | hook, lệnh, và phần nối chúng lại |

## Giới hạn

- **`@tiny` ít nơi dùng.** Pi không gọi model nền cho việc đặt tên session,
  memory hay phân loại auto-thinking, nên `@tiny` chỉ tự động làm gì đó khi
  `compactionRole` trỏ vào nó. Bên OMP, `tiny` lo hết mấy việc đó. Vẫn dùng được
  qua `@tiny` khi spawn và qua `/role tiny`.
- **`@vision` là nhãn, không phải router.** Không có gì soi attachment của bạn
  rồi tự đổi model; phải chỉ định thủ công.
- **`@commit` cũng là nhãn.** Pi không có hook riêng cho git. Gõ `/role commit`
  trước khi làm git, hoặc map một agent chuyên git vào role này.
- **Muốn gán model lúc spawn thì phải có tool spawn.** Không cài extension
  subagent nào thì hook `tool_call` không bao giờ chạy.
- **`pi-interactive-subagents` cần tmux.** Đó là ràng buộc của nó, không phải
  của extension này.

## Xử lý sự cố

**Không có lệnh `/roles`.** Extension chưa được load. Kiểm tra đường dẫn đúng
dạng `~/.pi/agent/extensions/<thư-mục>/index.ts` (hoặc package có trong
`pi list`), và bản cài project-local đã được trust.

**Một role hiện `✗ broken`.** Cả chuỗi của nó không khớp model khả dụng nào. Gõ
`/role` để xem toàn bảng, và đối chiếu `pi --list-models` — selector hôm qua còn
chạy vẫn gãy khi key provider hết hạn.

**Một role hiện `◐`.** Model chính không dùng được và fallback đang gánh. Thường
là vấn đề auth hoặc catalog của provider chính.

**Subagent vẫn chạy sai model.** Lời gọi đã truyền model cụ thể, và extension cố
ý không đụng vào. Bỏ tham số `model` đi, hoặc truyền `@role`.

**Model không biết tới `@alias`.** `injectPrompt` đang tắt, hoặc mọi role đều
chưa gán nên bảng tóm tắt rỗng.

**Advisor không nói gì.** Nó đang tắt (gõ `/advisor` để xem), chưa có model
resolve được, chưa đủ `everyTurns`, hoặc verdict dưới `minSeverity`.

**Mọi thứ chạy hai lần.** Bạn vừa cài package vừa clone vào
`~/.pi/agent/extensions/`. Bỏ một cái đi.

## Phát triển

```bash
git clone https://github.com/thucpru/pi-model-roles
cd pi-model-roles
npm install       # kéo @earendil-works/pi-tui, thứ mà test của bảng cần
npm test          # node --test --experimental-strip-types test/*.test.ts
pi -e .           # chạy phiên pi với bản checkout này
```

Cần Node 22+ để chạy TypeScript trực tiếp trong test. `types.ts` và `resolve.ts`
không import gì từ pi, còn `board.ts` chỉ import `pi-tui`, nên phần resolve và
toàn bộ bảng — phím, thay đổi config, và bất biến "không dòng nào vượt quá bề
rộng terminal" — đều test được mà không cần runtime của pi.

Không có bước build — pi nạp TypeScript qua
[jiti](https://github.com/unjs/jiti).

## So với OMP

| | OMP | pi-model-roles |
| --- | --- | --- |
| Config | `modelRoles` trong `~/.omp/agent/config.yml` | `~/.pi/agent/model-roles.json` |
| Role | default, smol, slow, vision, plan, commit, tiny, task, advisor | y hệt, thêm `designer`, thêm role tự tạo |
| Role tự tạo | `modelTags` | hạng nhất, tạo và xoá ngay trong TUI |
| Chuỗi fallback | — | có thứ tự, kèm báo cáo tình trạng |
| Alias | `@role`, `*` cho default | `@role` |
| Hậu tố thinking | `:high` v.v. | y hệt |
| Env / flag | `PI_SMOL_MODEL`, `--smol`, `--slow`, `--plan` | — (dùng `/role`) |
| `tiny` cho việc nền | title, memory, auto-thinking, phát hiện dừng | chỉ compaction — pi không expose hook cho phần còn lại |
| Advisor | tích hợp sẵn, có `WATCHDOG.md` | có, kèm lập kế hoạch giao việc theo role |
| Phạm vi project | `modelRoleStorage: project` | `<cwd>/.pi/model-roles.json` |

## Giấy phép

MIT — xem [LICENSE](LICENSE).
