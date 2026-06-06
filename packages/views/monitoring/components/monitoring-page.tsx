"use client";

import React from "react";
import { Boxes, MessageCircleQuestion, FileText, Scale, LayoutTemplate, BookOpen, NotebookPen } from "lucide-react";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@multica/ui/components/ui/tabs";
import { useNavigation } from "../../navigation";
import { useT } from "../../i18n";
import { QuestionsTab } from "./questions-tab";
import { ClassesTab } from "./classes-tab";
import { FactsTab } from "./facts-tab";
import { RulesTab } from "./rules-tab";
import { TemplatesTab } from "./templates-tab";
import { KnowledgesTab } from "./knowledges-tab";
import { DiaryTab } from "./diary-tab";

// Sub-navigated observability section, mirroring the Settings page layout:
// vertical tabs on the left, content on the right, active tab in `?tab=`.
const TAB_KEYS = ["questions", "classes", "facts", "rules", "templates", "knowledges", "diary"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_ICONS: Record<TabKey, React.ComponentType<{ className?: string }>> = {
  questions: MessageCircleQuestion,
  classes: Boxes,
  facts: FileText,
  rules: Scale,
  templates: LayoutTemplate,
  knowledges: BookOpen,
  diary: NotebookPen,
};

const DEFAULT_TAB: TabKey = "questions";
const TAB_QUERY_KEY = "tab";

export function MonitoringPage() {
  const { t } = useT("monitoring");
  const navigation = useNavigation();

  const validTabs = React.useMemo(() => new Set<string>(TAB_KEYS), []);
  const tabFromUrl = navigation.searchParams.get(TAB_QUERY_KEY);
  const activeTab =
    tabFromUrl && validTabs.has(tabFromUrl) ? tabFromUrl : DEFAULT_TAB;

  // replace (not push) so tab switches don't pollute browser history; keep any
  // other query params the page may carry.
  const handleTabChange = (next: string) => {
    const params = new URLSearchParams(navigation.searchParams);
    params.set(TAB_QUERY_KEY, next);
    navigation.replace(`${navigation.pathname}?${params.toString()}`);
  };

  return (
    <Tabs
      value={activeTab}
      onValueChange={handleTabChange}
      orientation="vertical"
      className="flex-1 min-h-0 gap-0 flex flex-col md:flex-row md:overflow-hidden overflow-y-auto"
    >
      {/* Left nav (stacks on top on mobile, sidebar on md+) */}
      <div className="shrink-0 md:w-52 border-b md:border-b-0 md:border-r md:overflow-y-auto p-3 md:p-4">
        <h1 className="text-sm font-semibold mb-4 px-2">
          {t(($) => $.page.title)}
        </h1>
        <TabsList variant="line" className="flex-col items-stretch w-full">
          {TAB_KEYS.map((key) => {
            const Icon = TAB_ICONS[key];
            return (
              <TabsTrigger key={key} value={key}>
                <Icon className="h-4 w-4" />
                {t(($) => $.nav[key])}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>

      {/* Right content */}
      <div className="flex-1 min-w-0 md:overflow-y-auto">
        <div className="w-full max-w-5xl mx-auto p-4 md:p-6">
          <TabsContent value="questions">
            <QuestionsTab />
          </TabsContent>
          <TabsContent value="classes">
            <ClassesTab />
          </TabsContent>
          <TabsContent value="facts">
            <FactsTab />
          </TabsContent>
          <TabsContent value="rules">
            <RulesTab />
          </TabsContent>
          <TabsContent value="templates">
            <TemplatesTab />
          </TabsContent>
          <TabsContent value="knowledges">
            <KnowledgesTab />
          </TabsContent>
          <TabsContent value="diary">
            <DiaryTab />
          </TabsContent>
        </div>
      </div>
    </Tabs>
  );
}
