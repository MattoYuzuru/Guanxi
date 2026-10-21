import { machine, type Story, type StoryMeta } from '../../story-kit/index.tsx'
import { useUiText } from '../../i18n/context.tsx'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
  type SelectProps,
} from './select.tsx'

const MODELS = [
  { value: 'qwen3-coder', label: machine('qwen3-coder:30b') },
  { value: 'gpt-oss', label: machine('gpt-oss:20b') },
  { value: 'llama', label: machine('llama3.1:8b') },
]

function SelectStory({
  open,
  value,
  disabled,
  invalid,
}: {
  open?: boolean
  value?: string | null
  disabled?: boolean
  invalid?: boolean
}) {
  const t = useUiText()
  return (
    <Select
      items={MODELS}
      defaultValue={value ?? null}
      open={open}
      modal={false}
      disabled={disabled}
    >
      <SelectTrigger aria-label={t('story.select.label')} invalid={invalid}>
        <SelectValue placeholder={t('story.select.placeholder')} />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectGroupLabel>{t('story.select.group')}</SelectGroupLabel>
          {MODELS.map((model) => (
            <SelectItem key={model.value} value={model.value} disabled={model.value === 'llama'}>
              {model.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  )
}

const meta = {
  title: 'Primitives/Select',
  component: Select,
  parameters: { guanxi: { frame: 'floating' } },
} satisfies StoryMeta<SelectProps>

export default meta

export const Placeholder: Story<SelectProps> = { name: 'placeholder', render: () => <SelectStory /> }

export const Selected: Story<SelectProps> = {
  name: 'selected',
  render: () => <SelectStory value="qwen3-coder" />,
}

export const Open: Story<SelectProps> = {
  name: 'open',
  render: () => <SelectStory open value="qwen3-coder" />,
}

export const Invalid: Story<SelectProps> = { name: 'invalid', render: () => <SelectStory invalid /> }

export const Disabled: Story<SelectProps> = {
  name: 'disabled',
  render: () => <SelectStory disabled value="gpt-oss" />,
}
