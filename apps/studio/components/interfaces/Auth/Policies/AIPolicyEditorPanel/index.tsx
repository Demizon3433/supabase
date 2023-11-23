import { FileDiff } from 'lucide-react'
import dynamic from 'next/dynamic'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Button, Modal, SidePanel } from 'ui'

import {
  IStandaloneCodeEditor,
  IStandaloneDiffEditor,
} from 'components/interfaces/SQLEditor/SQLEditor.types'
import ConfirmationModal from 'components/ui/ConfirmationModal'
import { useRlsSuggestMutation } from 'data/ai/rls-suggest-mutation'
import { useRlsSuggestQuery } from 'data/ai/rls-suggest-query'
import { useEntityDefinitionsQuery } from 'data/database/entity-definitions-query'
import { useExecuteSqlMutation } from 'data/sql/execute-sql-mutation'
import { useSelectedProject, useStore } from 'hooks'
import { AIPolicyChat } from './AIPolicyChat'
import { AIPolicyHeader } from './AIPolicyHeader'
import RLSCodeEditor from './RLSCodeEditor'

const DiffEditor = dynamic(
  () => import('@monaco-editor/react').then(({ DiffEditor }) => DiffEditor),
  { ssr: false }
)

interface AIPolicyEditorPanelProps {
  visible: boolean
  onSelectCancel: () => void
  onSaveSuccess: () => void
}

/**
 * Using memo for this component because everything rerenders on window focus because of outside fetches
 */
export const AIPolicyEditorPanel = memo(function ({
  visible,
  onSelectCancel,
  onSaveSuccess,
}: AIPolicyEditorPanelProps) {
  const { meta } = useStore()
  const selectedProject = useSelectedProject()
  const [incomingChange, setIncomingChange] = useState<string | undefined>(undefined)
  // used for confirmation when closing the panel with unsaved changes
  const [isClosingPolicyEditorPanel, setIsClosingPolicyEditorPanel] = useState(false)

  const editorRef = useRef<IStandaloneCodeEditor | null>(null)
  const diffEditorRef = useRef<IStandaloneDiffEditor | null>(null)

  const [assistantVisible, setAssistantPanel] = useState(false)
  const [ids, setIds] = useState<{ threadId: string; runId: string } | undefined>(undefined)

  const { data: entities } = useEntityDefinitionsQuery(
    {
      projectRef: selectedProject?.ref,
      connectionString: selectedProject?.connectionString,
    },
    { enabled: true, refetchOnWindowFocus: false }
  )

  const entityDefinitions = entities?.map((def) => def.sql.trim())

  const { data, isSuccess } = useRlsSuggestQuery(
    { thread_id: ids?.threadId!, run_id: ids?.runId! },
    {
      enabled: !!(ids?.runId && ids.threadId),
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchInterval: (data) => {
        if (data && data.status === 'completed') {
          return Infinity
        }
        return 5000
      },
    }
  )
  const { mutate: addPromptMutation } = useRlsSuggestMutation({
    onSuccess: (data) => {
      setIds({ threadId: data.threadId, runId: data.runId })
    },
  })

  const addPrompt = useCallback(
    (message: string) => {
      if (ids?.threadId) {
        addPromptMutation({
          thread_id: ids?.threadId,
          prompt: message,
        })
      } else {
        addPromptMutation({
          thread_id: ids?.threadId,
          entityDefinitions,
          prompt: message,
        })
      }
    },
    [addPromptMutation, entityDefinitions, ids?.threadId]
  )

  const { mutate: executeMutation, isLoading: isExecuting } = useExecuteSqlMutation({
    onSuccess() {
      // refresh all policies
      meta.policies.load()
      onSaveSuccess()
    },
  })

  const createNewPolicy = useCallback(() => {
    // clean up the sql before sending
    const policy = editorRef.current?.getValue().replaceAll('\n', ' ').replaceAll('  ', ' ')

    if (policy) {
      executeMutation({
        sql: policy,
        projectRef: selectedProject?.ref,
        connectionString: selectedProject?.connectionString,
      })
    }
  }, [executeMutation, selectedProject?.connectionString, selectedProject?.ref])

  const acceptChange = useCallback(async () => {
    if (!incomingChange) {
      return
    }

    if (!editorRef.current || !diffEditorRef.current) {
      return
    }

    const editorModel = editorRef.current.getModel()
    const diffModel = diffEditorRef.current.getModel()

    if (!editorModel || !diffModel) {
      return
    }

    const sql = diffModel.modified.getValue()

    // apply the incoming change in the editor directly so that Undo/Redo work properly
    editorRef.current.executeEdits('apply-ai-edit', [
      {
        text: sql,
        range: editorModel.getFullModelRange(),
      },
    ])

    // remove the incoming change to revert to the original editor
    setIncomingChange(undefined)
  }, [incomingChange])

  const onClosingPanel = useCallback(() => {
    const policy = editorRef.current?.getValue()
    if (policy) {
      setIsClosingPolicyEditorPanel(true)
    } else {
      onSelectCancel()
    }
  }, [onSelectCancel])

  // when the panel is closed, reset all values
  useEffect(() => {
    if (!visible) {
      const policy = editorRef.current?.getValue()
      if (policy) {
        editorRef.current?.setValue('')
      }
      if (incomingChange) {
        setIncomingChange(undefined)
      }
      if (assistantVisible) {
        setAssistantPanel(false)
      }
      setIsClosingPolicyEditorPanel(false)
      setIds(undefined)
    }
  }, [visible])

  return (
    <SidePanel
      size={assistantVisible ? 'xxxxlarge' : 'large'}
      visible={visible}
      disabled
      hideFooter
      onCancel={onClosingPanel}
    >
      <div className="flex flex-row h-full">
        <div className="flex flex-col w-screen max-w-2xl h-full border">
          <AIPolicyHeader
            assistantVisible={assistantVisible}
            setAssistantVisible={setAssistantPanel}
          />
          {incomingChange ? (
            <div className="px-5 py-3 flex justify-between gap-3 bg-muted">
              <div className="flex gap-2 items-center text-foreground-light">
                <FileDiff className="h-4 w-4" />
                <span className="text-sm">Replace code</span>
              </div>
              <div className="flex gap-3">
                <Button type="default" onClick={() => setIncomingChange(undefined)}>
                  Discard
                </Button>
                <Button type="primary" onClick={() => acceptChange()}>
                  Apply
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex-1">
            {incomingChange ? (
              <DiffEditor
                theme="supabase"
                language="pgsql"
                original={editorRef.current?.getValue()}
                modified={incomingChange}
                onMount={(editor) => (diffEditorRef.current = editor)}
                options={{
                  // render the diff inline
                  renderSideBySide: false,
                  scrollBeyondLastLine: false,
                }}
              />
            ) : null}
            {/* this editor has to rendered at all times to not lose its editing history */}
            <RLSCodeEditor
              id="rls-sql-policy"
              wrapperClassName={incomingChange ? '!hidden' : ''}
              defaultValue={''}
              editorRef={editorRef}
            />
          </div>
          <div className="flex justify-end gap-2 p-4 bg-overlay border-t border-overlay">
            <Button type="default" onClick={() => onSelectCancel()}>
              Cancel
            </Button>
            <Button
              loading={isExecuting}
              htmlType="submit"
              // disable the submit button when in diff mode
              disabled={incomingChange !== undefined}
              onClick={() => createNewPolicy()}
            >
              Insert policy
            </Button>
          </div>
        </div>
        {assistantVisible && (
          <div className="w-full bg-surface-200">
            <AIPolicyChat
              messages={isSuccess ? data.messages : []}
              onSubmit={(message: string) => addPrompt(message)}
              onDiff={(v) => setIncomingChange(v)}
              loading={data?.status === 'loading'}
            />
          </div>
        )}
      </div>
      <ConfirmationModal
        visible={isClosingPolicyEditorPanel}
        header="Discard changes"
        buttonLabel="Discard"
        onSelectCancel={() => setIsClosingPolicyEditorPanel(false)}
        onSelectConfirm={() => {
          onSelectCancel()
          setIsClosingPolicyEditorPanel(false)
        }}
      >
        <Modal.Content>
          <p className="py-4 text-sm text-foreground-light">
            There are unsaved changes. Are you sure you want to close the editor? Your changes will
            be lost.
          </p>
        </Modal.Content>
      </ConfirmationModal>
    </SidePanel>
  )
})

AIPolicyEditorPanel.displayName = 'AIPolicyEditorPanel'
